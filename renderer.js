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
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
// R32.7 — additive polish module. Single import; ?polish=off gracefully
// disables the entire pack at runtime. Effects stack on top of the existing
// renderer pipeline without modifying any existing materials or meshes.
import * as Polish from './renderer_polish.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js'; // R31.2

// --- Module state ---
let scene, camera, renderer, composer;
let bloomPass, gradePass;
let sunLight, hemiLight, sky;
let polish = null; // R32.7 polish module handle
let _lastTickTime = 0; // R32.7 dt source for polish.tick
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
    // R31.2: HDRI replaces THREE.Sky. initSky() is kept as fallback in case
    // the HDRI fetch fails; loadHDRISky() triggers that fallback via its error arm.
    loadHDRISky();   // async — sky + env set when HDRI loads; Sky fallback on error
    initSky();       // always runs for immediate Sky fallback, hidden if HDRI succeeds
    initTerrain();
    await initBuildings(); // R32.3: now async — loads canonical.json for per-datablock mesh classification
    await initInteriorShapes(); // R32.1: real Tribes 1 .dis-extracted meshes at canonical positions
    await initBaseAccents(); // R32.2: per-team VehiclePad + RepairPack + side-mounted flag stand
    initPlayers();
    initProjectiles();
    initFlags();
    initParticles();
    initWeaponViewmodel();
    initRain(); // R32.0: Raindance.MIS "Rain1" Snowfall
    // R32.32.1-manus: camera-local thin-blade grass ring. See initGrassRing
    // for the full architecture writeup. Wrapped in try/catch so any failure
    // can't black-screen the game (lesson from R32.25). Escape hatch: ?ring=off.
    try { initGrassRing(); } catch (e) { console.warn('[R32.32.1] initGrassRing failed:', e); }
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
    renderer.toneMappingExposure = 0.8;  // R31.1: 1.0→0.8 (set again in initScene)
    renderer.shadowMap.enabled = tier.shadowMap > 0;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    canvas.style.visibility = 'visible';
}

function initScene() {
    scene = new THREE.Scene();
    // R32.0: Raindance.MIS canonical fog — haze 200m, visible 450m, pale overcast
    scene.fog = new THREE.Fog(0xC0C8D0, 200, 450);
    scene.background = new THREE.Color(0xC0C8D0);
    // R32.25.4-DIAG: expose for diagnostic overlay
    try { window.scene = scene; window.camera = camera; window.renderer = renderer; } catch(e) {}
}

// ============================================================
// THREE.Sky atmospheric scattering + sun + lights
// ============================================================
let sunPos = new THREE.Vector3();

function initSky() {
    sky = new Sky();
    sky.scale.setScalar(450000);
    scene.add(sky);
    const u = sky.material.uniforms;
    // R30.2: rebalanced sky uniforms. Old values (turbidity=8, rayleigh=2.0)
    // produced washed-out white sky with harsh banding because tone mapping
    // was clipping the high luminance values. New values (turbidity=2,
    // rayleigh=1.0, mieG=0.8) produce a more typical clear-blue sky with a
    // visible sun disk and proper horizon haze.
    // R31.1: sky uniforms tuned up from R30.2's over-muted values.
    // turbidity=4 gives slight haze; rayleigh=2 recovers the deep blue zenith;
    // mieG=0.85 sharpens the sun-disk halo. The key change is in initRenderer():
    // exposure was 0.5 (too dim) → now 0.8 which brings out the dynamic range.
    u.turbidity.value = 4;
    u.rayleigh.value = 2.0;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.85;

    // R32.0: Raindance.MIS canonical sun — azimuth -90° (east), incidence 54°
    const azimuth = -90 + 180, elevation = 54;  // Three.js: azimuth from south, elevation above horizon
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth - 180);
    sunPos.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(sunPos);
}

// R30.2: build a PMREM environment from the Sky shader so PBR materials
// (MeshStandardMaterial used for buildings, soldiers, weapons, terrain)
// receive proper image-based ambient lighting instead of looking flat or
// dark when not directly hit by the sun. This is what makes the difference
// between "unlit-looking PBR" and "properly grounded PBR".
// R31.2: Real HDRI sky. Loads the vendored PolyHaven HDR, sets it as both
// scene.background (visible sky) and scene.environment (PBR ambient env map).
// If the fetch fails (CORS, missing asset, GitHub Pages path) the THREE.Sky
// fallback is already initialised by initSky() and we log + continue.
function loadHDRISky() {
    // R32.10: switched to overcast 'puresky' HDRI for moody Raindance valley feel.
    // overcast_soil_puresky has no ground in the lower hemisphere so it works as
    // a pure skybox over our terrain mesh. CC0 from polyhaven.com.
    const hdrPath = 'assets/hdri/overcast_soil_puresky_2k.hdr';
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    new RGBELoader().load(
        hdrPath,
        (hdrTex) => {
            hdrTex.mapping = THREE.EquirectangularReflectionMapping;
            const envRT = pmrem.fromEquirectangular(hdrTex);
            scene.environment = envRT.texture;
            scene.background  = envRT.texture;   // real HDRI as visible sky
            hdrTex.dispose();
            pmrem.dispose();
            // Hide the THREE.Sky procedural dome — it would double-draw behind HDRI
            if (sky) sky.visible = false;
            // R32.11.2: re-tuned exposure. R32.10.1 set exposure=0.6 because
            // flat-shaded faceted terrain had high local contrast that needed
            // dimming. Now (R32.11.1+) lighting is smooth-shaded so the scene
            // reads more uniformly — 0.6 is too dim, bumping to 0.95.
            // Background still dimmed (sky was the originally-bright issue).
            // Environment intensity bumped 1.0→1.25 to lift PBR fill on the
            // armor + props without over-brightening the sky dome.
            scene.backgroundIntensity = 0.55;       // was 0.45 — slightly less dim
            scene.environmentIntensity = 1.25;      // was 1.0 — lift PBR fill
            if (renderer) renderer.toneMappingExposure = 0.95;  // was 0.6
            console.log('[R32.11.2] HDRI sky loaded — exposure 0.95, bg 0.55, env 1.25');
        },
        undefined,  // progress not needed
        (err) => {
            // Graceful fallback: THREE.Sky remains visible (initSky already ran)
            pmrem.dispose();
            console.warn('[R31.2] HDRI load failed — falling back to THREE.Sky procedural:', err.message || err);
        }
    );
}

function buildEnvironmentFromSky() {
    if (!sky || !renderer) return;
    try {
        const pmrem = new THREE.PMREMGenerator(renderer);
        pmrem.compileEquirectangularShader();
        // Render the sky shader into a small offscreen scene
        const skyScene = new THREE.Scene();
        skyScene.add(sky.clone(false));
        const envRT = pmrem.fromScene(skyScene, 0, 0.1, 100000);
        scene.environment = envRT.texture;
        // Re-add the original sky to the visible scene since we cloned a placeholder
        if (!scene.children.includes(sky)) scene.add(sky);
        pmrem.dispose();
        console.log('[R30.2] PMREM environment built from Sky shader; PBR materials now lit');
    } catch (e) {
        console.warn('[R30.2] PMREM env build failed (non-fatal):', e);
    }
}

function initLights() {
    const tier = readQualityFromSettings();

    // R32.0: Raindance.MIS canonical atmosphere — overcast sky
    scene.background = new THREE.Color(0xC0C8D0);

    if (renderer) {
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.8;
        renderer.outputColorSpace = THREE.SRGBColorSpace;
    }

    // R32.0: Raindance.MIS canonical lighting — ambient 0.4 gray + warm ground
    hemiLight = new THREE.HemisphereLight(0xC0C8D0, 0x4D473B, 1.0);
    scene.add(hemiLight);

    // R32.0: Sun — azimuth -90°, incidence 54°, intensity 0.6 per .MIS
    sunLight = new THREE.DirectionalLight(0x999999, 1.4); // 0.6*1.4 ≈ 0.84 effective
    sunLight.castShadow = tier.shadowMap > 0;
    if (tier.shadowMap > 0) {
        sunLight.shadow.mapSize.set(tier.shadowMap, tier.shadowMap);
        sunLight.shadow.camera.near = 10;
        sunLight.shadow.camera.far = 800;
        const s = 200; // shadow frustum half-size, follows camera
        sunLight.shadow.camera.left = -s;
        sunLight.shadow.camera.right = s;
        sunLight.shadow.camera.top = s;
        sunLight.shadow.camera.bottom = -s;
        sunLight.shadow.bias = -0.0005;
        sunLight.shadow.normalBias = 0.02;
    }
    scene.add(sunLight);
    scene.add(sunLight.target);
}

// ============================================================
// Terrain — PBR with procedural noise textures
// ============================================================
function generateTerrainTextures() {
    const size = 512;

    // Hash-based pseudorandom for stable noise
    function h(a, b) {
        let n = (a | 0) * 374761393 + (b | 0) * 668265263;
        n = (n ^ (n >> 13)) * 1274126177;
        return ((n ^ (n >> 16)) & 0xFFFF) / 0xFFFF;
    }
    function smooth(t) { return t * t * (3 - 2 * t); }
    function noise2D(x, y) {
        let v = 0, freq = 1, amp = 1, total = 0;
        for (let oct = 0; oct < 5; oct++) {
            const xf = x * freq, yf = y * freq;
            const xi = Math.floor(xf), yi = Math.floor(yf);
            const fx = xf - xi, fy = yf - yi;
            const a = h(xi, yi), b = h(xi + 1, yi);
            const c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
            const u = smooth(fx), w = smooth(fy);
            v += amp * ((1 - u) * (1 - w) * a + u * (1 - w) * b + (1 - u) * w * c + u * w * d);
            total += amp;
            freq *= 2;
            amp *= 0.5;
        }
        return v / total;
    }

    // Diffuse: sandy-grass blend driven by noise
    const diffCanvas = document.createElement('canvas');
    diffCanvas.width = diffCanvas.height = size;
    const dctx = diffCanvas.getContext('2d');
    const dimg = dctx.createImageData(size, size);
    // Heightfield for normal computation (kept separately)
    const heights = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const n = noise2D(x / 18, y / 18);
            const detail = noise2D(x / 4, y / 4) * 0.25;
            const h = Math.max(0, Math.min(1, n * 0.85 + detail));
            heights[y * size + x] = h;
            // Sandy (n low) → dry-grass (n mid) → green-grass (n high)
            const sand = [196, 174, 124];
            const dry  = [148, 132, 86];
            const grass = [88, 110, 60];
            let r, g, b;
            if (h < 0.45) {
                const t = h / 0.45;
                r = sand[0] * (1 - t) + dry[0] * t;
                g = sand[1] * (1 - t) + dry[1] * t;
                b = sand[2] * (1 - t) + dry[2] * t;
            } else {
                const t = (h - 0.45) / 0.55;
                r = dry[0] * (1 - t) + grass[0] * t;
                g = dry[1] * (1 - t) + grass[1] * t;
                b = dry[2] * (1 - t) + grass[2] * t;
            }
            const i = (y * size + x) * 4;
            dimg.data[i] = r | 0;
            dimg.data[i + 1] = g | 0;
            dimg.data[i + 2] = b | 0;
            dimg.data[i + 3] = 255;
        }
    }
    dctx.putImageData(dimg, 0, 0);
    const diffTex = new THREE.CanvasTexture(diffCanvas);
    diffTex.wrapS = diffTex.wrapT = THREE.RepeatWrapping;
    diffTex.colorSpace = THREE.SRGBColorSpace;
    diffTex.anisotropy = 4;

    // Normal map: derive from height field via central differences
    const normCanvas = document.createElement('canvas');
    normCanvas.width = normCanvas.height = size;
    const nctx = normCanvas.getContext('2d');
    const nimg = nctx.createImageData(size, size);
    const strength = 8.0;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const xL = (x - 1 + size) % size;
            const xR = (x + 1) % size;
            const yU = (y - 1 + size) % size;
            const yD = (y + 1) % size;
            const dx = (heights[y * size + xR] - heights[y * size + xL]) * strength;
            const dy = (heights[yD * size + x] - heights[yU * size + x]) * strength;
            const nx = -dx;
            const ny = -dy;
            const nz = 1.0;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            const i = (y * size + x) * 4;
            nimg.data[i]     = (nx / len * 0.5 + 0.5) * 255;
            nimg.data[i + 1] = (ny / len * 0.5 + 0.5) * 255;
            nimg.data[i + 2] = (nz / len * 0.5 + 0.5) * 255;
            nimg.data[i + 3] = 255;
        }
    }
    nctx.putImageData(nimg, 0, 0);
    const normTex = new THREE.CanvasTexture(normCanvas);
    normTex.wrapS = normTex.wrapT = THREE.RepeatWrapping;
    normTex.anisotropy = 4;

    return { diffTex, normTex };
}

// R32.8 — procedurally generated PBR tile textures for splat shader.
// Each surface (grass / rock / dirt / sand) gets its own diffuse + normal at
// 256². They tile in world space; the shader picks the right one per pixel
// based on the splat map (slope + height auto-classified).
function _makeNoiseTexture(baseColor, variance, freq) {
    const N = 256;
    const c = document.createElement('canvas'); c.width = c.height = N;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(N, N);
    const d = img.data;
    // Multi-octave value noise
    function valueNoise(x, y, scale) {
        const xi = Math.floor(x * scale), yi = Math.floor(y * scale);
        const xf = x * scale - xi, yf = y * scale - yi;
        // Hash
        const h = (a, b) => {
            const s = Math.sin(a * 12.9898 + b * 78.233 + 17.0) * 43758.5453;
            return s - Math.floor(s);
        };
        const v00 = h(xi, yi), v10 = h(xi+1, yi);
        const v01 = h(xi, yi+1), v11 = h(xi+1, yi+1);
        const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf);
        return (v00 * (1-u) + v10 * u) * (1-w) + (v01 * (1-u) + v11 * u) * w;
    }
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const u = x / N, v = y / N;
            // 3 octaves
            const n = (valueNoise(u, v, freq) * 0.5
                     + valueNoise(u, v, freq * 2) * 0.3
                     + valueNoise(u, v, freq * 4) * 0.2);
            const t = (n - 0.5) * variance * 2;
            const idx = (y * N + x) * 4;
            d[idx]   = Math.max(0, Math.min(255, baseColor[0] + t * 255));
            d[idx+1] = Math.max(0, Math.min(255, baseColor[1] + t * 255));
            d[idx+2] = Math.max(0, Math.min(255, baseColor[2] + t * 255));
            d[idx+3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
}
function _makeNormalFromNoise(freq, intensity) {
    const N = 256;
    const c = document.createElement('canvas'); c.width = c.height = N;
    const ctx = c.getContext('2d');
    // Sample height noise then derive normals via central differences
    function valueNoise(x, y, scale) {
        const xi = Math.floor(x * scale), yi = Math.floor(y * scale);
        const xf = x * scale - xi, yf = y * scale - yi;
        const h = (a, b) => {
            const s = Math.sin(a * 12.9898 + b * 78.233 + 17.0) * 43758.5453;
            return s - Math.floor(s);
        };
        const v00 = h(xi, yi), v10 = h(xi+1, yi);
        const v01 = h(xi, yi+1), v11 = h(xi+1, yi+1);
        const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf);
        return (v00 * (1-u) + v10 * u) * (1-w) + (v01 * (1-u) + v11 * u) * w;
    }
    const heights = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const u = x / N, v = y / N;
            heights[y*N+x] = (valueNoise(u, v, freq) * 0.5
                            + valueNoise(u, v, freq*2) * 0.3
                            + valueNoise(u, v, freq*4) * 0.2);
        }
    }
    const img = ctx.createImageData(N, N);
    const d = img.data;
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const xL = (x - 1 + N) % N, xR = (x + 1) % N;
            const yU = (y - 1 + N) % N, yD = (y + 1) % N;
            const dx = (heights[y*N+xR] - heights[y*N+xL]) * intensity;
            const dy = (heights[yD*N+x] - heights[yU*N+x]) * intensity;
            const nx = -dx, ny = -dy, nz = 1.0;
            const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
            const idx = (y * N + x) * 4;
            d[idx]   = (nx / len * 0.5 + 0.5) * 255;
            d[idx+1] = (ny / len * 0.5 + 0.5) * 255;
            d[idx+2] = (nz / len * 0.5 + 0.5) * 255;
            d[idx+3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
}

// R32.8 — generate splat map by classifying every cell by slope and height.
// R = grass weight (flat, mid-low elevation)
// G = rock weight  (steep slopes)
// B = dirt weight  (mid slopes / building-adjacent)
// A = sand weight  (low elevation flats, e.g. dry valley near bridge)
function _generateSplatMap(heights, size, worldScale) {
    const N = 257; // splat resolution; doesn't need to be huge
    const c = document.createElement('canvas'); c.width = c.height = N;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(N, N);
    const d = img.data;
    // Find h range
    let hMin = Infinity, hMax = -Infinity;
    for (let i = 0; i < heights.length; i++) {
        if (heights[i] < hMin) hMin = heights[i];
        if (heights[i] > hMax) hMax = heights[i];
    }
    const hRange = hMax - hMin;
    function sampleH(u, v) {
        // u,v in [0,1]
        const x = u * (size - 1), y = v * (size - 1);
        const xi = Math.min(size - 2, Math.floor(x)), yi = Math.min(size - 2, Math.floor(y));
        const xf = x - xi, yf = y - yi;
        const h00 = heights[yi*size+xi], h10 = heights[yi*size+xi+1];
        const h01 = heights[(yi+1)*size+xi], h11 = heights[(yi+1)*size+xi+1];
        return h00*(1-xf)*(1-yf) + h10*xf*(1-yf) + h01*(1-xf)*yf + h11*xf*yf;
    }
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const u = x / (N - 1), v = y / (N - 1);
            const h = sampleH(u, v);
            const hN = (h - hMin) / Math.max(0.01, hRange); // 0..1 elevation
            // Slope estimate via central diff
            const eps = 1 / (N - 1);
            const hL = sampleH(Math.max(0, u - eps), v);
            const hR = sampleH(Math.min(1, u + eps), v);
            const hU = sampleH(u, Math.max(0, v - eps));
            const hD = sampleH(u, Math.min(1, v + eps));
            const dx = (hR - hL) / (2 * eps * (size - 1) * worldScale);
            const dy = (hD - hU) / (2 * eps * (size - 1) * worldScale);
            const slope = Math.sqrt(dx * dx + dy * dy); // slope as rise/run
            const slopeN = Math.min(1, slope * 1.5);
            // Add a bit of noise so transitions aren't perfectly smooth
            const ns = (Math.sin(x * 12.7 + y * 7.3) * 43758.5453);
            const noise = (ns - Math.floor(ns) - 0.5) * 0.15;
            // Classify
            let grass = Math.max(0, 1 - slopeN * 2.5);              // flat surfaces
            let rock  = Math.max(0, slopeN * 1.8 - 0.2);            // steep
            let dirt  = Math.max(0, 0.5 - Math.abs(slopeN - 0.4) * 2); // mid slope
            let sand  = Math.max(0, (1 - hN) * 0.7 - slopeN);        // low + flat
            // Add noise variation
            grass = Math.max(0, grass + noise);
            dirt  = Math.max(0, dirt + noise * 0.5);
            // Bias grass less in mountains
            grass *= Math.max(0.3, 1 - hN * 0.6);
            // Normalize so they sum to ~1
            const sum = grass + rock + dirt + sand + 1e-4;
            const idx = (y * N + x) * 4;
            d[idx]   = (grass / sum) * 255;
            d[idx+1] = (rock / sum) * 255;
            d[idx+2] = (dirt / sum) * 255;
            d[idx+3] = (sand / sum) * 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return { tex, splatRGBA: d, splatSize: N };
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
function initTerrain() {
    const ptr = Module._getHeightmapPtr();
    const size = Module._getHeightmapSize();
    const worldScale = Module._getHeightmapWorldScale();
    const heights = new Float32Array(Module.HEAPF32.buffer, ptr, size * size);
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

    // toNonIndexed() expands every shared vertex so each triangle has its own
    // 3 verts; computeVertexNormals() produces face normals (flat shading).
    // Both `normal` (face) and `aSmoothNormal` (per-original-vertex, copied to
    // each triangle's 3 verts) are now available — we pick smooth in the shader.
    const flatGeom = geom.toNonIndexed();
    flatGeom.computeVertexNormals();

    // ---- 5. Load 4 real CC0 PBR textures + build stochastic-tiled splat shader ----
    const loader = new THREE.TextureLoader();
    function loadTex(path, isColor) {
        const t = loader.load(path);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = 8;
        if (isColor) t.colorSpace = THREE.SRGBColorSpace;
        return t;
    }
    const grassC  = loadTex('assets/textures/terrain/grass001_color.jpg', true);
    const grassN  = loadTex('assets/textures/terrain/grass001_normal.jpg', false);
    const grassC2 = loadTex('assets/textures/terrain/grass002_color.jpg', true);   // R32.10 second grass tile
    const grassN2 = loadTex('assets/textures/terrain/grass002_normal.jpg', false);
    const rockC   = loadTex('assets/textures/terrain/rock030_color.jpg', true);
    const rockN   = loadTex('assets/textures/terrain/rock030_normal.jpg', false);
    const dirtC   = loadTex('assets/textures/terrain/ground037_color.jpg', true);
    const dirtN   = loadTex('assets/textures/terrain/ground037_normal.jpg', false);
    const sandC   = loadTex('assets/textures/terrain/ground003_color.jpg', true);
    const sandN   = loadTex('assets/textures/terrain/ground003_normal.jpg', false);

    const mat = new THREE.MeshStandardMaterial({
        map: grassC,                             // fallback if shader injection ever fails
        normalMap: grassN,
        normalScale: new THREE.Vector2(0.7, 0.7),
        roughness: 0.93,
        metalness: 0.0,
        envMapIntensity: 0.30,
    });
    mat.userData.tiles = { grassC, grassN, grassC2, grassN2, rockC, rockN, dirtC, dirtN, sandC, sandN };
    mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTileGrassC  = { value: grassC };
        shader.uniforms.uTileGrassN  = { value: grassN };
        shader.uniforms.uTileGrassC2 = { value: grassC2 };  // R32.10
        shader.uniforms.uTileGrassN2 = { value: grassN2 };
        shader.uniforms.uTileRockC   = { value: rockC };
        shader.uniforms.uTileRockN   = { value: rockN };
        shader.uniforms.uTileDirtC   = { value: dirtC };
        shader.uniforms.uTileDirtN   = { value: dirtN };
        shader.uniforms.uTileSandC   = { value: sandC };
        shader.uniforms.uTileSandN   = { value: sandN };
        shader.uniforms.uTerrainSize = { value: span };
        shader.uniforms.uTileMeters  = { value: 9.0 };
        // R32.32-manus: unified wind uniforms for the terrain-fuzz grass layer.
        // uTime advances per-frame in the main loop via _terrainShader.uniforms.uTime.value.
        // Driven by the same clock as any future blade geometry, so fuzz waves and
        // blade sway stay in lock-step (Principle 2: unified global wind).
        shader.uniforms.uTime        = { value: 0.0 };
        shader.uniforms.uWindDir     = { value: new THREE.Vector2(0.8, 0.6) }; // unit vec approx
        shader.uniforms.uWindSpeed   = { value: 0.85 };
        // R32.32-manus: ?fuzz=off escape hatch so we can A/B against bare painterly terrain.
        const _fuzzOff = (typeof location !== 'undefined') && /[?&]fuzz=off\b/.test(location.search);
        shader.uniforms.uGrassFuzz   = { value: _fuzzOff ? 0.0 : 1.0 };

        // R32.10.3 + R32.11.1: aWash/aAO vertex attrs are gone (replaced by
        // per-pixel fragment noise). aSplat stays per-vertex (smooth across
        // world XZ, re-normalized in fragment). NEW in R32.11.1: aSmoothNormal
        // attribute carries a smooth heightmap-derived normal at each vertex,
        // and we override `objectNormal` in `<beginnormal_vertex>` so PBR
        // lighting uses smooth normals — no more triangle-edge brightness jumps.
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>',
                `#include <common>
                 attribute vec4 aSplat;
                 attribute vec3 aSmoothNormal;
                 varying vec4 vSplat;
                 varying vec2 vWorldXZ;
                 varying float vWorldY;`)
            .replace('#include <beginnormal_vertex>',
                // Override the default `objectNormal` (which would be the flat
                // face normal computed by computeVertexNormals on the
                // non-indexed geometry) with our smooth per-vertex normal.
                // Result: lighting is smooth-shaded; geometry stays faceted.
                `vec3 objectNormal = aSmoothNormal;
                 #ifdef USE_TANGENT
                   vec3 objectTangent = vec3( tangent.xyz );
                 #endif`)
            .replace('#include <begin_vertex>',
                `#include <begin_vertex>
                 vSplat = aSplat;
                 vWorldXZ = position.xz;
                 vWorldY = position.y;`);

        // Fragment shader: stochastic anti-tiling sampling + grass A/B blend + wash + AO
        shader.fragmentShader = shader.fragmentShader
            .replace('uniform vec3 diffuse;',
                `uniform vec3 diffuse;
                 uniform sampler2D uTileGrassC;  uniform sampler2D uTileGrassN;
                 uniform sampler2D uTileGrassC2; uniform sampler2D uTileGrassN2;
                 uniform sampler2D uTileRockC;   uniform sampler2D uTileRockN;
                 uniform sampler2D uTileDirtC;   uniform sampler2D uTileDirtN;
                 uniform sampler2D uTileSandC;   uniform sampler2D uTileSandN;
                 uniform float uTileMeters;
                 uniform float uTerrainSize;
                 varying vec4 vSplat;
                 varying vec2 vWorldXZ;
                 varying float vWorldY;
                 // R32.32-manus: unified wind uniforms for grass-fuzz far-field layer
                 uniform float uTime;
                 uniform vec2 uWindDir;
                 uniform float uWindSpeed;
                 uniform float uGrassFuzz;
                 // 2D hash → angle in [0..2π)
                 float th_hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
                 // R32.10.1: smooth value noise for grass species blend (per-pixel, kills triangle-edge seams)
                 float vh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
                 float vnoise(vec2 p) {
                     vec2 i = floor(p), f = fract(p);
                     vec2 u = f*f*(3.0-2.0*f);
                     return mix(mix(vh(i), vh(i+vec2(1,0)), u.x),
                                mix(vh(i+vec2(0,1)), vh(i+vec2(1,1)), u.x), u.y);
                 }
                 // Stochastic 3-rotation sampling: take 3 differently-rotated samples of
                 // the same texture and blend by hashed weights, breaking the visible loop.
                 vec4 stochasticSample(sampler2D tex, vec2 uv) {
                     vec2 cellId = floor(uv);
                     vec2 f = fract(uv);
                     // Three offset rotated samples + 3 weights from 3 cell-hashes
                     float h0 = th_hash(cellId);
                     float h1 = th_hash(cellId + vec2(1.0, 0.0));
                     float h2 = th_hash(cellId + vec2(0.0, 1.0));
                     float a0 = h0 * 6.2831853;
                     float a1 = h1 * 6.2831853;
                     float a2 = h2 * 6.2831853;
                     mat2 R0 = mat2(cos(a0), -sin(a0), sin(a0), cos(a0));
                     mat2 R1 = mat2(cos(a1), -sin(a1), sin(a1), cos(a1));
                     mat2 R2 = mat2(cos(a2), -sin(a2), sin(a2), cos(a2));
                     vec4 s0 = texture2D(tex, R0 * uv + vec2(h0, h1));
                     vec4 s1 = texture2D(tex, R1 * uv + vec2(h1, h2));
                     vec4 s2 = texture2D(tex, R2 * uv + vec2(h2, h0));
                     // Weights from triangular blend across the cell
                     float w0 = (1.0 - f.x) * (1.0 - f.y);
                     float w1 = f.x * (1.0 - f.y);
                     float w2 = f.y;
                     float wSum = w0 + w1 + w2 + 1e-4;
                     return (s0 * w0 + s1 * w1 + s2 * w2) / wSum;
                 }`)
            .replace('#include <map_fragment>',
                `// Re-normalize splat (vertex interp may break unity)
                 float wSum = max(1e-4, vSplat.r + vSplat.g + vSplat.b + vSplat.a);
                 vec4 splatW = vSplat / wSum;
                 vec2 tUv = vWorldXZ / uTileMeters;
                 // R32.10.1: grass species blend per-pixel (period ~80m).
                 float gMix = smoothstep(0.30, 0.70, vnoise(vWorldXZ * 0.0125));
                 vec4 cG1 = stochasticSample(uTileGrassC,  tUv);
                 vec4 cG2 = stochasticSample(uTileGrassC2, tUv * 0.83 + vec2(13.7, 7.1));
                 vec4 cG  = mix(cG1, cG2, gMix);
                 vec4 cR  = stochasticSample(uTileRockC,  tUv);
                 vec4 cD  = stochasticSample(uTileDirtC,  tUv);
                 vec4 cS  = stochasticSample(uTileSandC,  tUv);
                 vec4 sampledDiffuseColor = cG * splatW.r + cR * splatW.g + cD * splatW.b + cS * splatW.a;
                 // R32.10.3: per-pixel watercolor wash (replaces vWash vertex attribute).
                 // Three-octave smooth noise gives painterly color drift with NO seams.
                 float n1 = vnoise(vWorldXZ * 0.012);
                 float n2 = vnoise(vWorldXZ * 0.045 + vec2(31.7, 19.3));
                 float n3 = vnoise(vWorldXZ * 0.18 + vec2(7.4, 53.1));
                 float washCombo = n1 * 0.55 + n2 * 0.30 + n3 * 0.15;
                 // Ridge warmth from world height (proxy: vWorldY relative to half
                 // the terrain Y-span; safe approximation since heightmap is
                 // [6.65,76.9]m, mid ~42m). Cool valleys, warm ridges — painterly.
                 float hN = clamp((vWorldY - 6.65) / 70.25, 0.0, 1.0);
                 vec3 wash = vec3(1.0);
                 wash.r += (washCombo - 0.5) * 0.10 + (hN - 0.4) * 0.06;
                 wash.g += (washCombo - 0.5) * 0.06 + (hN - 0.4) * 0.02;
                 wash.b += (washCombo - 0.5) * 0.04 - (hN - 0.4) * 0.05;
                 // R32.10.3: per-pixel AO from world-Y screen-space derivatives.
                 // dFdx/dFdy of vWorldY gives the slope of the surface in screen
                 // pixels. Steeper terrain = bigger derivatives = darker shading.
                 // Doesn't depend on vNormal (which is gone in FLAT_SHADED mode).
                 // Add macro height shading too: low areas slightly darker.
                 float dy = abs(dFdx(vWorldY)) + abs(dFdy(vWorldY));
                 float slopeShade = 1.0 - smoothstep(0.05, 0.40, dy) * 0.35;
                 float heightShade = 0.78 + 0.22 * hN;
                 float pAO = slopeShade * heightShade;
                 sampledDiffuseColor.rgb *= wash;
                 sampledDiffuseColor.rgb *= pAO;
                 // R32.32.1-manus: removed the grass-fuzz block from R32.32 step 1 —
                 // user feedback was "It looks like noise static texture". Static
                 // 2D fragment patterns can't sell as 3D grass blades because
                 // there's no parallax cue. Reverting to plain painterly terrain
                 // for the far field; near-field readability is now the job of
                 // step 2 (camera-local thin-blade ring geometry).
                 diffuseColor *= sampledDiffuseColor;`)
            .replace('#include <normal_fragment_maps>',
                `vec2 nUv = vWorldXZ / uTileMeters;
                 vec3 nG1 = stochasticSample(uTileGrassN,  nUv).xyz * 2.0 - 1.0;
                 vec3 nG2 = stochasticSample(uTileGrassN2, nUv * 0.83 + vec2(13.7, 7.1)).xyz * 2.0 - 1.0;
                 vec3 nG  = mix(nG1, nG2, gMix);
                 vec3 nR = stochasticSample(uTileRockN,  nUv).xyz * 2.0 - 1.0;
                 vec3 nD = stochasticSample(uTileDirtN,  nUv).xyz * 2.0 - 1.0;
                 vec3 nS = stochasticSample(uTileSandN,  nUv).xyz * 2.0 - 1.0;
                 vec3 mapN = normalize(nG * splatW.r + nR * splatW.g + nD * splatW.b + nS * splatW.a);
                 mapN.xy *= normalScale;
                 normal = normalize( tbn * mapN );`);
        mat.userData.shader = shader;
    };

    terrainMesh = new THREE.Mesh(flatGeom, mat);
    terrainMesh.receiveShadow = true;
    scene.add(terrainMesh);
    console.log('[R32.10] Painterly terrain: faceted ' + size + 'x' + size + ', dual-grass blend + path zones + wet patches + stochastic splat (CC0 PBR x5)');
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
        const pedGeom = new THREE.CylinderGeometry(halfExtents[0] * 0.9, halfExtents[0] * 1.05, halfExtents[1] * 1.4, 10);
        const ped = new THREE.Mesh(pedGeom, baseMat);
        ped.position.y = halfExtents[1] * 0.7;
        ped.castShadow = ped.receiveShadow = true;
        group.add(ped);
        const domeGeom = new THREE.SphereGeometry(halfExtents[0] * 1.1, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55);
        const dome = new THREE.Mesh(domeGeom, accentMat);
        dome.position.y = halfExtents[1] * 1.45;
        dome.castShadow = true;
        group.add(dome);
        const barrelGeom = new THREE.CylinderGeometry(0.13, 0.16, 1.4, 8);
        const barrel = new THREE.Mesh(barrelGeom, accentMat);
        barrel.rotation.z = Math.PI / 2;
        barrel.position.set(halfExtents[0] * 1.0, halfExtents[1] * 1.45, 0);
        barrel.castShadow = true;
        group.add(barrel);
        // Sensor "eye" — small emissive dot on dome
        const eyeGeom = new THREE.SphereGeometry(0.08, 8, 6);
        const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff3333 });
        const eye = new THREE.Mesh(eyeGeom, eyeMat);
        eye.position.set(halfExtents[0] * 0.9, halfExtents[1] * 1.55, 0.0);
        group.add(eye);
        group.userData = { barrel: barrel };
    } else if (type === 4) {
        // STATION — cylindrical kiosk + glowing display
        const cylGeom = new THREE.CylinderGeometry(halfExtents[0] * 1.2, halfExtents[0] * 1.3, halfExtents[1] * 2, 14);
        const cyl = new THREE.Mesh(cylGeom, baseMat);
        cyl.position.y = halfExtents[1];
        cyl.castShadow = cyl.receiveShadow = true;
        group.add(cyl);
        // Glowing top ring
        const ringGeom = new THREE.TorusGeometry(halfExtents[0] * 1.3, 0.06, 6, 24);
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
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x6a6862, roughness: 0.78, metalness: 0.18 });
    const armMat  = new THREE.MeshStandardMaterial({ color: 0x484540, roughness: 0.55, metalness: 0.55 });
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
        const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 0.9, 8), armMat);
        stack.position.y = hy * 2 + 0.65; g.add(stack);
        g.userData = { panels: panels };
        return g;
    }

    if (datablock === 'AmmoStation' || datablock === 'InventoryStation' || datablock === 'CommandStation') {
        // Hex kiosk — differentiate by accent color of top ring.
        const r = 1.0, h = 1.5;
        const body = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.1, r * 1.2, h * 2, 6), baseMat);
        body.position.y = h; body.castShadow = body.receiveShadow = true; g.add(body);
        // Top ring (datablock-tinted to differentiate at a glance)
        let ringHex = 0xFFC850; // default
        if (datablock === 'AmmoStation')      ringHex = 0xFF8030; // amber/orange
        if (datablock === 'InventoryStation') ringHex = 0x40C0FF; // cyan
        if (datablock === 'CommandStation')   ringHex = 0xFFE060; // gold
        const ringMat = new THREE.MeshBasicMaterial({ color: ringHex });
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.18, 0.08, 6, 24), ringMat);
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
        const stripe = new THREE.Mesh(new THREE.TorusGeometry(r * 1.22, 0.04, 6, 18), glowMat);
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
        const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.05, pedH, 12), baseMat);
        ped.position.y = pedH * 0.5; ped.castShadow = ped.receiveShadow = true; g.add(ped);
        const dome = new THREE.Mesh(new THREE.SphereGeometry(0.95, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), armMat);
        dome.position.y = pedH + 0.05; g.add(dome);
        // Plasma coil ring (emissive, slow rotation in syncBuildings if needed)
        const coil = new THREE.Mesh(new THREE.TorusGeometry(0.65, 0.07, 8, 18), accentMat);
        coil.rotation.x = Math.PI / 2; coil.position.y = pedH + 0.45; g.add(coil);
        // Forward cannon
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.20, 1.5, 10), armMat);
        barrel.rotation.z = Math.PI / 2; barrel.position.set(0.85, pedH + 0.45, 0); g.add(barrel);
        // Sensor eye
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.10, 8, 6), glowMat);
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
                const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.55, 8), accentMat);
                tube.rotation.x = Math.PI / 2;
                tube.position.set(0.45 * s, pedH + 0.55 + (m === 0 ? 0.18 : -0.18), 0.0);
                g.add(tube);
            }
        }
        // Forward sensor
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.10, 8, 6), glowMat);
        eye.position.set(0, pedH + 0.45, 0.71); g.add(eye);
        return g;
    }

    if (datablock === 'PulseSensor') {
        // Slim pole with rotating dish at top — distinct from turrets
        const poleH = 2.4;
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.13, poleH, 8), baseMat);
        pole.position.y = poleH * 0.5; pole.castShadow = pole.receiveShadow = true; g.add(pole);
        // Cap
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.15, 12), armMat);
        cap.position.y = poleH + 0.07; g.add(cap);
        // Dish (shallow paraboloid as half-sphere flattened)
        const dish = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.35), accentMat);
        dish.position.y = poleH + 0.20; g.add(dish);
        // Pulsing emissive dot at dish center
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), glowMat);
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
    let canonicalCount = 0, fallbackCount = 0;

    for (let b = 0; b < count; b++) {
        const o = b * stride;
        const px = view[o], py = view[o + 1], pz = view[o + 2];
        const hx = view[o + 3], hy = view[o + 4], hz = view[o + 5];
        const type = view[o + 6];
        const isRock = (type === 5);
        if (isRock) continue;
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
        fallbackCount, 'legacy fallback (total ' + buildingMeshes.length + ')');
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
        const [blobRes, infoRes, canonRes] = await Promise.all([
            fetch('assets/maps/raindance/raindance_meshes.bin'),
            fetch('assets/maps/raindance/raindance_meshes.json'),
            fetch('assets/maps/raindance/canonical.json'),
        ]);
        if (!blobRes.ok || !infoRes.ok || !canonRes.ok) {
            console.warn('[R32.1] Interior shape assets missing; skipping');
            return;
        }
        const blob = await blobRes.arrayBuffer();
        const info = await infoRes.json();
        const canon = await canonRes.json();

        // Parse the binary blob. Format:
        //   u32 'RDMS', u32 version, u32 num_meshes
        //   per mesh: u8 nameLen, char[nameLen] name,
        //             u32 nVerts, f32[3*nVerts] positions,
        //             u32 nIndices, u32[nIndices] indices
        const dv = new DataView(blob);
        let off = 0;
        const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
        off = 4;
        if (magic !== 'RDMS') { console.warn('[R32.1] bad magic', magic); return; }
        const version = dv.getUint32(off, true); off += 4;
        const num = dv.getUint32(off, true); off += 4;
        if (version !== 1) console.warn('[R32.1] unexpected mesh blob version', version);
        const meshes = new Map();
        for (let i = 0; i < num; i++) {
            const nameLen = dv.getUint8(off); off += 1;
            const nameBytes = new Uint8Array(blob, off, nameLen);
            const name = new TextDecoder('utf-8').decode(nameBytes);
            off += nameLen;
            const nVerts = dv.getUint32(off, true); off += 4;
            const positions = new Float32Array(blob.slice(off, off + nVerts * 12));
            off += nVerts * 12;
            const nIdx = dv.getUint32(off, true); off += 4;
            const indices = new Uint32Array(blob.slice(off, off + nIdx * 4));
            off += nIdx * 4;
            meshes.set(name, { positions, indices, nVerts });
        }
        console.log('[R32.1] Loaded', meshes.size, 'unique interior-shape meshes');

        // R32.1.1: lighter, double-sided material so meshes are visible even if a
        // few backface-winding outliers slip through the index flip. Concrete-grey
        // tint with subtle warmth — matches the Raindance lush-base palette.
        const baseMat = new THREE.MeshStandardMaterial({
            color: 0xA89D90, roughness: 0.78, metalness: 0.08,
            flatShading: true,
            side: THREE.DoubleSide,
            emissive: 0x1a1814, emissiveIntensity: 0.35,
        });

        // Create a parent group for easy hide/show + selective culling
        interiorShapesGroup = new THREE.Group();
        interiorShapesGroup.name = 'RaindanceInteriorShapes';
        scene.add(interiorShapesGroup);

        // Helper: convert MIS position to world
        const toWorld = (mp) => ({ x: mp[0], y: mp[2], z: -mp[1] });

        // Build BufferGeometry once per unique fileName, reuse across instances.
        // Tribes 1 used DirectX-style left-handed coords with CW winding; Three.js
        // is right-handed with CCW winding. We flip the index winding (i,j,k)->(i,k,j)
        // so face normals computed by computeVertexNormals point outward.
        const geomCache = new Map();
        const getGeom = (fileName) => {
            if (geomCache.has(fileName)) return geomCache.get(fileName);
            const m = meshes.get(fileName);
            if (!m) return null;
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
            // Flip winding
            const flipped = new Uint32Array(m.indices.length);
            for (let t = 0; t < m.indices.length; t += 3) {
                flipped[t]   = m.indices[t];
                flipped[t+1] = m.indices[t+2];
                flipped[t+2] = m.indices[t+1];
            }
            g.setIndex(new THREE.BufferAttribute(flipped, 1));
            g.computeVertexNormals();
            g.computeBoundingBox();
            g.computeBoundingSphere();
            geomCache.set(fileName, g);
            return g;
        };

        // Place every neutral_interior_shapes instance.
        // Use a Group-wrapper-per-instance so we can apply yaw (around world Y)
        // INDEPENDENTLY from the local Tribes-z-up to Three-y-up rotation.
        let placed = 0, missed = 0;
        const items = (canon.neutral_interior_shapes || []);
        for (const item of items) {
            const geom = getGeom(item.fileName);
            if (!geom) { missed++; continue; }
            const mesh = new THREE.Mesh(geom, baseMat);
            // Inner: rotate -90deg around X to map Tribes local-z-up to Three y-up
            mesh.rotation.x = -Math.PI / 2;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.frustumCulled = false; // mirror existing buildings policy
            // Outer group: positions in world, applies yaw around world Y
            const outer = new THREE.Group();
            const w = toWorld(item.position);
            outer.position.set(w.x, w.y, w.z);
            const rotZ = (item.rotation && item.rotation[2]) ? -item.rotation[2] : 0;
            outer.rotation.y = rotZ;
            outer.add(mesh);
            outer.userData = { fileName: item.fileName, isInterior: true };
            interiorShapesGroup.add(outer);
            placed++;
        }
        console.log('[R32.1] Interior shapes placed:', placed, '(missed', missed, ')');

        // R32.1 O1 (corrected R32.1.1): push world-space AABBs to C++ for collision.
        // Manus R32.1.1 changed rotation architecture: inner mesh Rx(-PI/2), outer Group Ry(rotZ).
        //   Step 1: inner mesh rotation.x = -PI/2: DIS (lx,ly,lz_up) → (lx, lz, -ly)
        //   Step 2: outer Group rotation.y = rotZ (was Rz on single mesh — now Ry on group):
        //           Ry: wx = ax*cos(r)+az*sin(r), wy = ay, wz = -ax*sin(r)+az*cos(r)
        //   Step 3: translate by world position
        if (typeof Module !== 'undefined' && Module._appendInteriorShapeAABBs && Module._malloc && Module.HEAPF32) {
            const meshBounds = new Map();
            for (const s of info.meshes) meshBounds.set(s.fileName, { mn: s.bounds_min, mx: s.bounds_max });

            const aabbData = [];
            for (const item of items) {
                const bd = meshBounds.get(item.fileName);
                if (!bd) continue;
                const [bx0,by0,bz0] = bd.mn, [bx1,by1,bz1] = bd.mx;
                const w = toWorld(item.position);
                const meshRotZ = -(item.rotation?.[2] ?? 0);
                const cosR = Math.cos(meshRotZ), sinR = Math.sin(meshRotZ);
                const corners = [
                    [bx0,by0,bz0],[bx1,by0,bz0],[bx0,by1,bz0],[bx1,by1,bz0],
                    [bx0,by0,bz1],[bx1,by0,bz1],[bx0,by1,bz1],[bx1,by1,bz1],
                ];
                let mnX=Infinity,mnY=Infinity,mnZ=Infinity, mxX=-Infinity,mxY=-Infinity,mxZ=-Infinity;
                for (const [lx,ly,lz] of corners) {
                    // Step 1: inner Rx(-PI/2): (lx,ly,lz) → (lx, lz, -ly)
                    const ax=lx, ay=lz, az=-ly;
                    // Step 2: outer Ry(rotZ): wx=ax*cos+az*sin, wy=ay, wz=-ax*sin+az*cos
                    const fx = ax*cosR + az*sinR + w.x;
                    const fy = ay + w.y;
                    const fz = -ax*sinR + az*cosR + w.z;
                    mnX=Math.min(mnX,fx); mxX=Math.max(mxX,fx);
                    mnY=Math.min(mnY,fy); mxY=Math.max(mxY,fy);
                    mnZ=Math.min(mnZ,fz); mxZ=Math.max(mxZ,fz);
                }
                aabbData.push(mnX,mnY,mnZ, mxX,mxY,mxZ);
            }
            if (aabbData.length > 0) {
                const count = aabbData.length / 6;
                const bytes = aabbData.length * 4;
                const ptr = Module._malloc(bytes);
                if (ptr) {
                    Module.HEAPF32.set(aabbData, ptr / 4);
                    Module._appendInteriorShapeAABBs(count, ptr);
                    Module._free(ptr);
                }
            }
        }
    } catch (e) {
        console.error('[R32.1] initInteriorShapes failed', e);
    }
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
                const dot = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), dotMat);
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
    if (!tier.postProcess) {
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
    composer.addPass(bloomPass);
    if (tier.postProcess === 'full') {
        gradePass = new ShaderPass(makeVignetteAndGradeShader());
        composer.addPass(gradePass);
    }
    composer.addPass(new OutputPass());
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
function initScene_camera_init() {} // intentionally empty placeholder

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
    import('./renderer_command_map.js').then(() => {
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
    }).catch(e => console.warn('[R32.17] CommandMap load failed:', e));

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
                } catch (e) {}
            }
        }
        _r327PrevParticleAge[i] = age;
        if (age <= 0) continue;
        const dst = activeCount * 3;
        particlePositions[dst]     = particleView[o];
        particlePositions[dst + 1] = particleView[o + 1];
        particlePositions[dst + 2] = particleView[o + 2];
        const type = particleView[o + 6] | 0;
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
        window._tribesCamDist = is3P ? 4.0 : 0.0; // hot-snap on init so first frame is clean
        window._tribesCamHeight = is3P ? 1.6 : 1.7;
    }
    const targetDist = is3P ? 4.0 : 0.0;
    const targetHeight = is3P ? 1.6 : 1.7;
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
        const cf = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
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
        window._tribesAimPoint3P = { x: hitX, y: hitY, z: hitZ };
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
    const fovThreshold = zoomActive ? 0.05 : 0.5;
    if (Math.abs(camera.fov - fov) > fovThreshold) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
    }

    // Sun follows the camera so the (smaller) shadow frustum covers active area
    sunLight.position.set(px + sunPos.x * 800, py + sunPos.y * 800, pz + sunPos.z * 800);
    sunLight.target.position.set(px, py, pz);
    sunLight.target.updateMatrixWorld();
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
    const flagStateByTeam = [0, 0]; // index = team
    if (flagView && flagStride) {
        for (let i = 0; i < 2; i++) {
            const fo = i * flagStride;
            const ft = flagView[fo + 3] | 0;
            const fs = flagView[fo + 4] | 0;
            if (ft === 0 || ft === 1) flagStateByTeam[ft] = fs;
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
                const fstate = flagStateByTeam[ud.team] || 0;
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
// Render loop
// ============================================================
function loop() {
    if (!Module._isReady || !Module._isReady()) {
        requestAnimationFrame(loop);
        return;
    }
    const t = performance.now() * 0.001;
    Module._tick();
    syncPlayers(t);
    syncProjectiles();
    syncFlags(t);
    syncParticles();
    syncTurretBarrels(t);
    syncCamera();
    updateRain(1 / 60, camera.position); // R32.0 rain tick

    // R32.7 — polish tick (lightning, shake, FOV punch, splashes, smoke, HUD)
    if (polish) {
        const now = performance.now() * 0.001;
        const dt = _lastTickTime > 0 ? Math.min(0.1, now - _lastTickTime) : 1/60;
        _lastTickTime = now;
        polish.tick(dt, t);
        // R32.13-manus: combat FX tick (muzzle flash decay, tracer fade)
        if (window.CombatFX && window.CombatFX.update) window.CombatFX.update(dt);
        // R32.15-manus: viewmodel sway (jet dip+jitter, ski lean+bob, idle drift)
        _updateViewmodelSway(dt);
        // R32.17-manus: command map full-screen tactical overlay (toggled with C)
        if (window.CommandMap && window.CommandMap.update) window.CommandMap.update();
    }

    // R32.22: tick gradePass time uniform so the cinematic film grain animates.
    if (gradePass && gradePass.material && gradePass.material.uniforms && gradePass.material.uniforms.time) {
        gradePass.material.uniforms.time.value = (gradePass.material.uniforms.time.value + 0.05) % 10000.0;
    }

    // R32.25: cohesion tick (sub-perceptual camera breathing).
    if (window.Cohesion && window.Cohesion.tick) window.Cohesion.tick();

    // R32.27-manus: tick grass wind. updateGrassWind has existed since R32.8 but
    // was never actually called from the loop — grass uTime was stuck at 0 since
    // R32.8, so the sin sway never animated. Wiring it up now as part of the
    // Ghibli-grass upgrade so the noise-driven chaotic wind actually moves.
    // R32.31-manus: grass system removed; wind tick skipped.
    // updateGrassWind(t);

    // R32.32.1-manus: tick the camera-local grass ring (wind + recycle).
    // The old terrain-fuzz uTime tick from R32.32 is gone (fuzz removed),
    // but the ring uses the SAME unified clock for its wind shader so the
    // motion of every grass element stays in lock-step (Principle 2).
    try { updateGrassRing(t); } catch (e) { /* swallowed; ring is cosmetic */ }

    if (composer) composer.render();
    else renderer.render(scene, camera);

    // R30.0: one-shot diagnostic dump on first real frame to ground-truth what's
    // actually in the scene vs what the boot logs claim. The user's video showed
    // a half-empty world (terrain + black silhouettes) despite the [R18] init
    // logs saying 39 buildings + 16 soldiers were created. We need to know:
    //   - which meshes are actually in the scene graph
    //   - which are visible / culled / parentless
    //   - what materials they have
    //   - what the scene root's bounding box covers
    //   - what lights exist and where
    //   - what the camera sees
    if (!_r30Diagnosed) {
        _r30Diagnosed = true;
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

            // Scene root immediate children
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

            // Camera state
            console.log('[R30.0] camera position:', [camera.position.x.toFixed(1), camera.position.y.toFixed(1), camera.position.z.toFixed(1)],
                        ' rotation:', [camera.rotation.x.toFixed(2), camera.rotation.y.toFixed(2), camera.rotation.z.toFixed(2)],
                        ' near=' + camera.near + ' far=' + camera.far + ' fov=' + camera.fov);

            // Render info
            const info = renderer.info;
            console.log('[R30.0] renderer.info: ' + info.render.calls + ' calls, ' + info.render.triangles + ' tris, ' + info.memory.geometries + ' geom, ' + info.memory.textures + ' tex, programs=' + info.programs.length);

            // Fog + background
            console.log('[R30.0] scene.background:', scene.background ? (scene.background.isColor ? '#'+scene.background.getHexString() : scene.background.type) : 'null',
                        ' scene.fog:', scene.fog ? scene.fog.type + ' density=' + (scene.fog.density!==undefined ? scene.fog.density : 'near='+scene.fog.near+' far='+scene.fog.far) : 'null');

            console.log('[R30.0] === END DIAGNOSTIC DUMP ===');
        } catch (e) {
            console.error('[R30.0] diagnostic dump threw:', e);
        }
        console.log('[R29] First Three.js frame submitted');
    }

    _frameCount++;
    const now = performance.now();
    if (now - _lastDiagTime > 5000) {
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
// R32.8 — Instanced cross-quad grass + scattered detail props
// One InstancedMesh of an X-shape per grass tuft, GPU-distributed across
// the terrain. Density driven by splat.r (grass weight). Wind sway via
// vertex shader injection. LOD via per-frame distance fade.
// ============================================================
let _grassMesh = null;
let _grassMat = null;
let _propsMeshes = []; // [InstancedMesh,...] for rocks/scrub

function _makeGrassBladeTexture() {
    // R32.27-manus: Ghibli-style blade silhouette + brighter green gradient ramp.
    // Shifted from muddy olive to the saturated yellow-green of Antaeus AR's
    // GhibliGrass / Princess Mononoke meadow. Tip is sun-bleached, base is
    // shadow-rich. Wider blade silhouette so individual blades read at distance.
    const W = 64, H = 128; // taller canvas so the blade has more vertical resolution
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const grad = ctx.createLinearGradient(0, H, 0, 0);
    grad.addColorStop(0.00, 'rgba(45,  72, 28, 1.0)');   // base shadow (deeper)
    grad.addColorStop(0.35, 'rgba(95, 145, 55, 1.0)');   // mid (saturated grass green)
    grad.addColorStop(0.75, 'rgba(165, 205, 95, 1.0)');  // upper (bright)
    grad.addColorStop(1.00, 'rgba(215, 235, 145, 1.0)'); // tip (sun-bleached)
    ctx.fillStyle = grad;
    // Wider, less pinched silhouette — reads as a chunky Ghibli blade, not a
    // thin needle. Edges curve smoothly to a single tip vertex at top-center.
    ctx.beginPath();
    // R32.28-manus: thinner blade. Base narrowed 30-70% -> 42-58% canvas.
    ctx.moveTo(W * 0.42, H);                              // bottom-left
    ctx.lineTo(W * 0.58, H);                              // bottom-right
    ctx.quadraticCurveTo(W * 0.62, H * 0.55, W * 0.52, 0); // right edge to tip
    ctx.quadraticCurveTo(W * 0.38, H * 0.55, W * 0.42, H); // left edge back
    ctx.closePath();
    ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 4;
    return tex;
}

function initGrass() {
    if (!_splatData || !_htData) return;
    const tier = (window.__qualityTier || 'mid');
    if (tier === 'low') return; // skip on low

    // R32.27-manus: ?grass=classic restores the R32.8 cross-quad sin-sway look
    // (an escape hatch in case the Ghibli reproduction misbehaves on a GPU).
    const params = new URLSearchParams(window.location.search);
    const _classicMode = (params.get('grass') === 'classic');

    // R32.27-manus: bumped densities. The Ghibli look depends on visual density
    // — sparse blades read as scrub, dense blades read as a meadow. With the
    // single-triangle hot-path on high tier (12x fewer tris per blade than the
    // cross-quad), we can spend the saved triangles on more blades and end up
    // both visually richer AND lower triangle count than R32.26.
    //   high/ultra: 80k -> 140k blades  (single-tri => 140k tris vs old 960k)
    //   mid:        30k ->  55k blades  (single-tri =>  55k tris vs old 360k)
    //   classic mode keeps old counts and old cross-quad geometry.
    // R32.29-manus: user wants "100% map coverage" — R32.28's 140k on mid
    // gave 1 blade per 28 m² (a blade every 5.3m on center), unmistakably
    // sparse. Bumping ~4x to 600k mid / 1.5M high gets us to ~7 m² and ~3 m²
    // per blade respectively — reads as an actual meadow at eye level. Single-
    // tri geometry keeps total tris at 1.5M on high (still 1.5x the R32.8
    // cross-quad budget of 960k, but R32.8 was visibly patchy so the old
    // budget was too low). Frame rate will be watched — if this drops below
    // 45fps on mid we switch to Path B (camera-local density ring).
    const TARGET = _classicMode
        ? ((tier === 'high' || tier === 'ultra') ? 80000 : 30000)
        : ((tier === 'high' || tier === 'ultra') ? 1500000 : 600000);
    const span = (_htSize - 1) * _htScale;
    const half = span * 0.5;

    // R32.27-manus: blade geometry depends on mode.
    //   classic  -> R32.8 cross-quad (12 tris, 24 verts) for opt-out compatibility
    //   default  -> Antaeus-AR-style single triangle (1 tri, 3 verts) per blade.
    //               Two bottom verts at base, one tip vert centered above. uv.y=0
    //               at base (sway anchor), uv.y=1 at tip (sway tip). 12x cheaper
    //               at the geometry stage, identical visual at ground level.
    const bladeGeom = new THREE.BufferGeometry();
    if (_classicMode) {
        const verts = new Float32Array([
            // Quad A
            -0.5, 0, 0,   0.5, 0, 0,   0.5, 1, 0,
            -0.5, 0, 0,   0.5, 1, 0,  -0.5, 1, 0,
            // Quad B (90° rotated)
             0, 0, -0.5,  0, 0, 0.5,  0, 1, 0.5,
             0, 0, -0.5,  0, 1, 0.5,  0, 1, -0.5,
        ]);
        const uvs = new Float32Array([
            0,0, 1,0, 1,1,
            0,0, 1,1, 0,1,
            0,0, 1,0, 1,1,
            0,0, 1,1, 0,1,
        ]);
        bladeGeom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
        bladeGeom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    } else {
        // Single triangle per blade. ~0.4m wide at base, 1.0m tall (scaled by
        // per-instance matrix below). Bottom verts at uv.y=0 lock the blade to
        // the ground; top vert at uv.y=1 receives the full wind displacement.
        const verts = new Float32Array([
            -0.20, 0, 0,   0.20, 0, 0,   0.0, 1.0, 0,
        ]);
        const uvs = new Float32Array([
            0, 0,   1, 0,   0.5, 1,
        ]);
        bladeGeom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
        bladeGeom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    }
    bladeGeom.computeVertexNormals();

    const bladeTex = _makeGrassBladeTexture();
    _grassMat = new THREE.MeshStandardMaterial({
        map: bladeTex,
        transparent: true,
        alphaTest: 0.4,
        side: THREE.DoubleSide,
        roughness: 0.95,
        metalness: 0.0,
    });
    // R32.27-manus: chaotic noise-driven wind, replacing the R32.8 global sin sway.
    //
    // The R32.8 sway used a single sin() of (uTime + worldXZ) which produced a
    // clean uniform wave — every blade in a region moved in lockstep. The Ghibli
    // look needs the OPPOSITE: each blade swaying with its own phase and amplitude
    // so the meadow looks alive, not metronomic.
    //
    // Instead of paying the cost of a vertex texture fetch on a noise texture
    // (which would hurt mobile/integrated GPUs — see analysis), we synthesize
    // cheap pseudo-noise *in the shader* from the per-instance position. Three
    // overlapping sin waves at incommensurate frequencies + a per-instance phase
    // hash give the chaotic look at zero memory bandwidth cost. ~5 ALU ops per
    // vertex, no texture sampler needed.
    _grassMat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = { value: 0 };
        shader.uniforms.uWindStrength = { value: 0.28 };
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>',
                `#include <common>
                 uniform float uTime;
                 uniform float uWindStrength;`)
            .replace('#include <begin_vertex>',
                `#include <begin_vertex>
                 // Per-instance phase hash from world XZ (instanceMatrix col 3).
                 // sin/cos are commutative and cheap; this gives every blade its
                 // own unique offset without a texture lookup.
                 float ix = instanceMatrix[3].x;
                 float iz = instanceMatrix[3].z;
                 float phase = ix * 0.071 + iz * 0.097;
                 // Three overlapping waves at incommensurate frequencies fake
                 // a noise-driven wind without a texture fetch. The 0.93 / 0.51
                 // ratios are deliberately not multiples of each other, so the
                 // pattern doesn't resolve into a visible repetition.
                 float w1 = sin(uTime * 1.7  + phase);
                 float w2 = sin(uTime * 0.93 + phase * 1.71 + 1.7);
                 float w3 = sin(uTime * 0.51 + phase * 2.43 - 0.4);
                 // Combine and weight — w1 dominates (gust), w2/w3 add chaos.
                 // Multiplied by uv.y so only the tip moves, base stays planted.
                 float swayX = (w1 * 0.6 + w2 * 0.3 + w3 * 0.1) * uWindStrength;
                 float swayZ = (w1 * 0.3 + w2 * 0.6 - w3 * 0.1) * uWindStrength * 0.7;
                 transformed.x += swayX * uv.y;
                 transformed.z += swayZ * uv.y;
                 // Subtle tip droop on strong gust — blade bends forward, doesn't
                 // just translate sideways. Adds the Ghibli windblown feel.
                 transformed.y -= abs(swayX) * uv.y * 0.15;`);
        _grassMat.userData.shader = shader;
    };

    _grassMesh = new THREE.InstancedMesh(bladeGeom, _grassMat, TARGET);
    _grassMesh.frustumCulled = false; // we manage culling via distance + per-frame visibility
    _grassMesh.receiveShadow = false;
    _grassMesh.castShadow = false;

    // Sample positions across terrain weighted by splat.r (grass weight).
    // Rejection sampling: pick random world point, look up splat, accept if random<grass.
    // R32.27.3-manus: field names changed in R32.9 painterly terrain rewrite from
    // {splatRGBA, splatSize} -> {splatAttr, size}. initGrass kept reading the old
    // names (it was dead code from R32.9 to R32.27.2 so nobody hit the bug). The
    // splatAttr layout is identical to splatRGBA (RGBA per vertex, square grid of
    // side `size`), so the rejection-sampler math is unchanged — just rename the
    // reads. Defensive guards for missing fields below so a future rename can't
    // silently take grass down again.
    const splat = _splatData.splatAttr || _splatData.splatRGBA;
    const splatN = _splatData.size || _splatData.splatSize;
    if (!splat || !splatN) {
        console.warn('[R32.27.3] initGrass aborted: _splatData missing splatAttr/size', _splatData);
        return;
    }
    const dummy = new THREE.Object3D();
    let placed = 0;
    let attempts = 0;
    while (placed < TARGET && attempts < TARGET * 12) {
        attempts++;
        const wx = (Math.random() - 0.5) * span;
        const wz = (Math.random() - 0.5) * span;
        const u = (wx + half) / span, v = (wz + half) / span;
        const sx = Math.min(splatN - 1, Math.max(0, Math.floor(u * (splatN - 1))));
        const sy = Math.min(splatN - 1, Math.max(0, Math.floor(v * (splatN - 1))));
        // R32.27.3-manus: splatAttr stores normalized weights (0..1 Float32),
        // not 0..255 bytes — do NOT divide by 255 (legacy splatRGBA was bytes).
        const grassW = splat[(sy * splatN + sx) * 4];
        // R32.28-manus: loosened rejection threshold 1.1 -> 2.5 so mixed-grass
        // areas (grass+dirt, grass+sand) accept blades instead of being bald.
        if (Math.random() > grassW * 2.5) continue;
        const wy = sampleTerrainH(wx, wz);
        if (!Number.isFinite(wy)) continue;
        // R32.27-manus: slightly taller blades + wider scale range. Single-tri
        // blades read smaller than cross-quads at the same scale, so we bump up.
        // Random width (x) and height (y) decoupled gives a more natural meadow
        // — some short stubby blades, some tall reedy ones.
        const baseScale = 0.55 + Math.random() * 0.65; // 0.55–1.20
        const heightMul = 0.85 + Math.random() * 0.55; // 0.85–1.40 vertical stretch
        dummy.position.set(wx, wy, wz);
        dummy.rotation.y = Math.random() * Math.PI * 2;
        dummy.scale.set(baseScale, baseScale * heightMul, baseScale);
        dummy.updateMatrix();
        _grassMesh.setMatrixAt(placed, dummy.matrix);
        placed++;
    }
    _grassMesh.count = placed;
    _grassMesh.instanceMatrix.needsUpdate = true;
    scene.add(_grassMesh);
    console.log('[R32.8] Grass instanced:', placed, 'tufts (target', TARGET + ')');
}

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

    const tier = (window.__qualityTier || 'mid');
    const N = (tier === 'ultra') ? 120000 : (tier === 'high') ? 80000 : (tier === 'mid') ? 50000 : (tier === 'low') ? 0 : 50000;
    if (N === 0) {
        console.log('[R32.32.1] Grass ring skipped on low tier');
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
        const r = Math.sqrt(Math.random()) * RING_RADIUS;
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
    console.log('[R32.32.1] Grass ring placed:', N, 'thin blades in', RING_RADIUS, 'm camera-local ring');
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
    const RECYCLE_PER_FRAME = Math.min(2500, Math.floor(N * 0.04));
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
        const r = Math.sqrt(Math.random()) * RING_RADIUS;
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

// Detail props: scatter low-poly rock/scrub instances on rock-weighted terrain
function initDetailProps() {
    if (!_splatData || !_htData) return;
    const tier = (window.__qualityTier || 'mid');
    if (tier === 'low') return;

    const span = (_htSize - 1) * _htScale;
    const half = span * 0.5;
    const splat = _splatData.splatRGBA;
    const splatN = _splatData.splatSize;

    // Rocks
    const rockGeom = new THREE.IcosahedronGeometry(1, 0);
    // Distort for variation
    const pos = rockGeom.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const j = (Math.sin(i * 12.9898) * 43758.5453);
        const noise = (j - Math.floor(j) - 0.5) * 0.4;
        pos.setXYZ(i, x + noise * x, y + noise * y * 0.6, z + noise * z);
    }
    rockGeom.computeVertexNormals();
    const rockMat = new THREE.MeshStandardMaterial({
        color: 0x6f6660, roughness: 0.9, metalness: 0.05, flatShading: true,
    });
    const ROCK_COUNT = (tier === 'high' || tier === 'ultra') ? 1200 : 500;
    const rockMesh = new THREE.InstancedMesh(rockGeom, rockMat, ROCK_COUNT);
    rockMesh.castShadow = true; rockMesh.receiveShadow = true;
    const dummy = new THREE.Object3D();
    let placed = 0, attempts = 0;
    while (placed < ROCK_COUNT && attempts < ROCK_COUNT * 20) {
        attempts++;
        const wx = (Math.random() - 0.5) * span;
        const wz = (Math.random() - 0.5) * span;
        const u = (wx + half) / span, v = (wz + half) / span;
        const sx = Math.min(splatN - 1, Math.max(0, Math.floor(u * (splatN - 1))));
        const sy = Math.min(splatN - 1, Math.max(0, Math.floor(v * (splatN - 1))));
        const rockW = splat[(sy * splatN + sx) * 4 + 1] / 255;
        const dirtW = splat[(sy * splatN + sx) * 4 + 2] / 255;
        const acceptW = rockW * 0.9 + dirtW * 0.2;
        if (Math.random() > acceptW * 0.8) continue;
        const wy = sampleTerrainH(wx, wz);
        if (!Number.isFinite(wy)) continue;
        const scale = 0.3 + Math.random() * 1.4;
        dummy.position.set(wx, wy + scale * 0.2, wz);
        dummy.rotation.set(Math.random() * 0.4, Math.random() * Math.PI * 2, Math.random() * 0.4);
        dummy.scale.set(scale, scale * (0.6 + Math.random() * 0.5), scale);
        dummy.updateMatrix();
        rockMesh.setMatrixAt(placed, dummy.matrix);
        placed++;
    }
    rockMesh.count = placed;
    rockMesh.instanceMatrix.needsUpdate = true;
    scene.add(rockMesh);
    _propsMeshes.push(rockMesh);
    console.log('[R32.8] Rock props instanced:', placed);
}

// Per-frame grass wind tick (called from animate loop)
function updateGrassWind(t) {
    if (_grassMat && _grassMat.userData.shader) {
        _grassMat.userData.shader.uniforms.uTime.value = t;
    }
}
