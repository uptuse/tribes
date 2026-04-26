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

// --- Module state ---
let scene, camera, renderer, composer;
let bloomPass, gradePass;
let sunLight, hemiLight, sky;
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
    initSky();
    initTerrain();
    initBuildings();
    initPlayers();
    initProjectiles();
    initFlags();
    initParticles();
    initWeaponViewmodel();
    // R29.2: initStateViews() must run BEFORE initPostProcessing() because the
    // RenderPass(scene, camera) constructor captures the camera reference, and
    // initStateViews() is where `camera` is actually created. Previously the
    // order was reversed, so RenderPass got camera===undefined and every frame
    // crashed with `Cannot read properties of undefined (reading 'parent')` at
    // WebGLRenderer.render line 30015 (camera.parent === null check).
    initStateViews();
    initPostProcessing();
    console.log('[R29.2] State views + post-process initialized in correct order (camera-first)');
    console.log('[R29] Scene populated, ready to render');

    // Listen for settings changes (graphics quality dropdown)
    window.addEventListener('resize', onResize);
    window.__tribesApplyQuality = applyQuality;
    onResize();

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
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = tier.shadowMap > 0;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    canvas.style.visibility = 'visible';
}

function initScene() {
    scene = new THREE.Scene();
    // Exponential fog blends distant geometry to sky horizon
    scene.fog = new THREE.FogExp2(0xb8c4c8, 0.0006);
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
    u.turbidity.value = 2;
    u.rayleigh.value = 1.0;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.8;

    // Sun position: azimuth 60° (from north toward east), elevation 35°
    const azimuth = 60, elevation = 35;
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

    // R30.1: also set a fallback scene background color so that if the Sky
    // shader fails to draw (e.g. behind the camera, broken uniforms), we get
    // a sky-blue clear instead of WebGL's default black or window white.
    scene.background = new THREE.Color(0x9bb5d6);

    // R30.2: enable proper tone mapping so the Sky shader's high-dynamic-range
    // output doesn't clip to flat white. ACESFilmic is the standard for
    // outdoor PBR scenes; exposure=0.5 prevents over-bright sky.
    if (renderer) {
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.5;
        renderer.outputColorSpace = THREE.SRGBColorSpace;
    }

    // Hemisphere ambient — sky=#9bb5d6 ground=#5a4a32 (per R18 brief)
    // R30.1: bumped intensity 0.55 → 1.1 so building MeshStandardMaterial
    // doesn't render as black silhouettes in the absence of direct sun.
    // Even without the directional light reaching them, hemi alone now
    // produces visible PBR shading.
    hemiLight = new THREE.HemisphereLight(0x9bb5d6, 0x5a4a32, 1.1);
    scene.add(hemiLight);

    // Directional sun
    sunLight = new THREE.DirectionalLight(0xfff4e0, 1.4);
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

function initTerrain() {
    const ptr = Module._getHeightmapPtr();
    const size = Module._getHeightmapSize();
    const worldScale = Module._getHeightmapWorldScale();
    const heights = new Float32Array(Module.HEAPF32.buffer, ptr, size * size);

    const span = (size - 1) * worldScale;
    const segs = size - 1;

    const geom = new THREE.PlaneGeometry(span, span, segs, segs);
    geom.rotateX(-Math.PI / 2);

    const pos = geom.attributes.position;
    for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
            const linear = j * size + i;
            pos.setY(linear, heights[linear]);
        }
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();

    // UV tile so textures repeat ~64x across the 2048-unit terrain
    const uv = geom.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) * 64, uv.getY(i) * 64);
    }
    uv.needsUpdate = true;

    const { diffTex, normTex } = generateTerrainTextures();
    const mat = new THREE.MeshStandardMaterial({
        map: diffTex,
        normalMap: normTex,
        normalScale: new THREE.Vector2(1.2, 1.2),
        roughness: 0.95,
        metalness: 0.0,
    });
    terrainMesh = new THREE.Mesh(geom, mat);
    terrainMesh.receiveShadow = true;
    scene.add(terrainMesh);
    console.log('[R18] Terrain built: PBR with procedural noise diffuse + normal');
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
        const panelMat = new THREE.MeshBasicMaterial({ color: 0x40FF80, transparent: true, opacity: 0.75 });
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
        group.userData = { panels: group.children.slice(1, 5), aliveColor: 0x40FF80, deadColor: 0x404040 };
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

function initBuildings() {
    const ptr = Module._getBuildingPtr();
    const count = Module._getBuildingCount();
    const stride = Module._getBuildingStride();
    const view = new Float32Array(Module.HEAPF32.buffer, ptr, count * stride);
    for (let b = 0; b < count; b++) {
        const o = b * stride;
        const px = view[o], py = view[o + 1], pz = view[o + 2];
        const hx = view[o + 3], hy = view[o + 4], hz = view[o + 5];
        const type = view[o + 6];
        const isRock = (type === 5);
        if (isRock) continue;
        const cr = view[o + 10], cg = view[o + 11], cb = view[o + 12];
        const mesh = createBuildingMesh(type, [hx, hy, hz], [cr, cg, cb]);
        mesh.position.set(px, py, pz);
        // R31: disable frustum culling on all building sub-meshes; unlit accent
        // children (MeshBasicMaterial) were the ONLY ones rendering when PBR
        // body meshes were culled due to zero bounding spheres.
        mesh.traverse(child => { child.frustumCulled = false; });
        scene.add(mesh);
        buildingMeshes.push({ mesh, type });
    }
    console.log('[R18] Buildings:', buildingMeshes.length, 'composite meshes (turret/station/generator/interior/tower)');
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

    // Body (chest) — tapered cylinder
    const bodyGeom = new THREE.CylinderGeometry(t.bodyR * 0.85, t.bodyR, t.bodyH, 10);
    const body = new THREE.Mesh(bodyGeom, armorMat);
    body.position.y = 1.10;
    body.castShadow = true; body.receiveShadow = true;
    group.add(body);

    // Hips
    const hipsGeom = new THREE.BoxGeometry(t.bodyR * 1.6, 0.18, t.bodyR * 1.0);
    const hips = new THREE.Mesh(hipsGeom, accentMat);
    hips.position.y = 0.55;
    hips.castShadow = true;
    group.add(hips);

    // Head
    const headGeom = new THREE.SphereGeometry(0.20, 12, 10);
    const head = new THREE.Mesh(headGeom, armorMat);
    head.position.y = 1.78;
    head.castShadow = true;
    group.add(head);

    // Helmet (cap)
    const helmetGeom = new THREE.SphereGeometry(0.24, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.50);
    const helmet = new THREE.Mesh(helmetGeom, accentMat);
    helmet.position.y = 1.82;
    helmet.castShadow = true;
    group.add(helmet);

    // Visor band
    const visorGeom = new THREE.BoxGeometry(0.36, 0.09, 0.30);
    const visor = new THREE.Mesh(visorGeom, visorMat);
    visor.position.set(0, 1.74, 0.10);
    group.add(visor);

    // Shoulders
    const shoulderGeom = new THREE.SphereGeometry(t.shoulderR, 8, 6);
    const lShoulder = new THREE.Mesh(shoulderGeom, armorMat);
    lShoulder.position.set(-t.bodyR - t.shoulderR * 0.3, 1.45, 0);
    lShoulder.castShadow = true;
    group.add(lShoulder);
    const rShoulder = lShoulder.clone();
    rShoulder.position.x = -lShoulder.position.x;
    group.add(rShoulder);

    // Arm groups (pivot at shoulder for animation)
    function makeArm(side) {
        const armGroup = new THREE.Group();
        armGroup.position.set(side * (t.bodyR + t.shoulderR * 0.3), 1.45, 0);
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
    group.add(leftArm);
    group.add(rightArm);

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

    // Jetpack (on back)
    const jetGeom = new THREE.BoxGeometry(...t.jet);
    const jet = new THREE.Mesh(jetGeom, accentMat);
    jet.position.set(0, 1.20, -t.bodyR - t.jet[2] * 0.45);
    jet.castShadow = true;
    group.add(jet);

    // Jet thrusters
    const thrustGeom = new THREE.CylinderGeometry(0.07, 0.10, 0.18, 8);
    const lThrust = new THREE.Mesh(thrustGeom, accentMat);
    lThrust.position.set(-0.16, 0.78, -t.bodyR - t.jet[2] * 0.45);
    group.add(lThrust);
    const rThrust = lThrust.clone();
    rThrust.position.x = 0.16;
    group.add(rThrust);

    group.scale.setScalar(t.scale);

    group.userData = {
        armor: armor,
        leftArm, rightArm, leftLeg, rightLeg, body,
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
        ud.leftLeg.rotation.x = 0;
        ud.rightLeg.rotation.x = 0;
        ud.leftArm.rotation.x = 0;
        ud.rightArm.rotation.x = 0;
        ud.body.rotation.x = 0;
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
    // R30.2: scaled up the simple viewmodel so it's actually visible in the
    // lower-right of the screen. The previous (0.15, 0.10, 0.45) box was so
    // small at near-plane=0.5 that it was below 1 pixel.
    const geom = new THREE.BoxGeometry(0.06, 0.05, 0.30);
    const mat = new THREE.MeshStandardMaterial({ color: 0x6a6a72, roughness: 0.45, metalness: 0.55 });
    weaponHand = new THREE.Mesh(geom, mat);
    // R31: standard FPS weapon position — firmly lower-right, barrel forward.
    // Three.js camera looks down -Z, so -z is into the screen.
    weaponHand.position.set(0.25, -0.20, -0.45);
    weaponHand.rotation.set(0.0, 0.05, 0.0);
    // Tiny barrel detail so it actually reads as a weapon
    const barrelGeom = new THREE.CylinderGeometry(0.012, 0.012, 0.18, 8);
    const barrel = new THREE.Mesh(barrelGeom, mat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0.0, 0.01, -0.22);
    weaponHand.add(barrel);
    // (Set up after camera is initialized in initStateViews/loop)
}

// ============================================================
// Particles — type-aware shader-driven pool
// ============================================================
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
    bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.4, 0.6, 0.85);
    composer.addPass(bloomPass);
    if (tier.postProcess === 'full') {
        gradePass = new ShaderPass(makeVignetteAndGradeShader());
        composer.addPass(gradePass);
    }
    composer.addPass(new OutputPass());
}

function makeVignetteAndGradeShader() {
    return {
        uniforms: {
            tDiffuse: { value: null },
            vignetteIntensity: { value: 0.18 },
            warmth: { value: 0.06 },
            desaturation: { value: 0.10 },
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
            varying vec2 vUv;
            void main(){
                vec4 c = texture2D(tDiffuse, vUv);
                // Slight desaturation
                float gray = dot(c.rgb, vec3(0.299, 0.587, 0.114));
                c.rgb = mix(c.rgb, vec3(gray), desaturation);
                // Warm shift in shadows
                float lum = (c.r + c.g + c.b) / 3.0;
                float shadowMask = 1.0 - smoothstep(0.0, 0.5, lum);
                c.r += warmth * shadowMask;
                c.b -= warmth * shadowMask;
                // Vignette
                vec2 uv = vUv - 0.5;
                float v = 1.0 - dot(uv, uv) * vignetteIntensity * 4.0;
                c.rgb *= v;
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
    camera = new THREE.PerspectiveCamera(90, aspect, 0.5, 5000);
    // R30.1: place camera high above the basin center so the FIRST FRAME
    // (before WASM spawns the player) shows the terrain + buildings + sky
    // rather than burying the camera at (0,0,0) under the ground.
    camera.position.set(0, 200, 0);
    camera.lookAt(-300, 30, -300);   // look toward the map basin center
    scene.add(camera);
    camera.add(weaponHand);

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
        if (i === localIdx) {
            mesh.visible = false;
            if (nameplateSprites[i]) nameplateSprites[i].visible = false;
            continue;
        }
        mesh.visible = visible && alive;
        if (!mesh.visible) {
            if (nameplateSprites[i]) nameplateSprites[i].visible = false;
            continue;
        }

        mesh.position.set(playerView[o], playerView[o + 1], playerView[o + 2]);
        // R31: negate yaw to match Three.js convention (same fix as camera)
        mesh.rotation.set(0, -playerView[o + 4], 0, 'YXZ');

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
        animatePlayer(mesh, playerView[o + 6], playerView[o + 8],
                      playerView[o + 14] > 0.5, playerView[o + 15] > 0.5,
                      t, alive);
    }
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

function syncParticles() {
    const tier = QUALITY_TIERS[currentQuality];
    const cap = tier.particleCap;
    let activeCount = 0;
    for (let i = 0; i < MAX_PARTICLES && activeCount < cap; i++) {
        const o = i * particleStride;
        const age = particleView[o + 7];
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

    camera.position.set(px, py + 1.7, pz);
    // R31: negate yaw. C++ forward = {sin(yaw), 0, -cos(yaw)}.
    // Three.js camera forward at rotation.y=θ = {-sin(θ), 0, -cos(θ)}.
    // Setting rotation.y = -yaw makes Three.js forward = {sin(yaw), 0, -cos(yaw)} ✓.
    // Without this, W moved the player sideways relative to the camera view.
    camera.rotation.set(pitch, -yaw, 0, 'YXZ');

    const fov = Module._getCameraFov();
    if (Math.abs(camera.fov - fov) > 0.5) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
    }

    // Sun follows the camera so the (smaller) shadow frustum covers active area
    sunLight.position.set(px + sunPos.x * 800, py + sunPos.y * 800, pz + sunPos.z * 800);
    sunLight.target.position.set(px, py, pz);
    sunLight.target.updateMatrixWorld();
}

function syncTurretBarrels() {
    // Aim turret barrel toward nearest visible enemy player (cosmetic; doesn't affect simulation)
    // For R18, just keep the barrel rotating slowly so it visibly moves
    const t = performance.now() * 0.0005;
    for (const b of buildingMeshes) {
        if (b.type === 3 && b.mesh.userData && b.mesh.userData.barrel) {
            b.mesh.rotation.y = Math.sin(t + b.mesh.position.x * 0.1) * 0.5;
        }
    }
}

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
    syncTurretBarrels();
    syncCamera();

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
