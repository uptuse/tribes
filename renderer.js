// ============================================================
// Tribes Browser Edition — Three.js Renderer (R15)
// ============================================================
// Architecture: C++ simulation in WASM, Three.js renderer in JS.
// JS reads game state via zero-copy Float32Array views into HEAPF32.
// No JSON, no per-frame EM_ASM. All sync is typed-array reads.
// ============================================================

import * as THREE from 'three';

// --- Module state ---
let scene, camera, renderer;
let sunLight, hemiLight;
let terrainMesh;
let playerMeshes = [];
let projectileMeshes = [];
let flagMeshes = [];
let buildingMeshes = [];
let particlePoints, particleGeom, particlePositions, particleColors, particleSizes;

// Typed-array views into WASM HEAPF32 (built once at start, reused every frame).
// Memory growth is disabled in build.sh, so .buffer never detaches.
let playerView, projectileView, particleView, flagView;
let playerStride, projectileStride, particleStride, flagStride;

// Constants
const MAX_PARTICLES = 1024;
const MAX_PROJECTILES = 256;
const MAX_PLAYERS = 16;
const TEAM_COLORS = [0xC8302C, 0x2C5AC8, 0x808080]; // red, blue, neutral
const PROJ_COLORS = [
    0xFFFFFF, // 0 blaster
    0xFFEE40, // 1 chaingun
    0xE0E0FF, // 2 disc
    0x4F8030, // 3 grenade
    0xFF6020, // 4 plasma
    0xFFA040, // 5 mortar
    0xFF4040, // 6 laser
    0x80A0FF, // 7 elf
    0x40FF80, // 8 repair
];

// Reused tmp objects — avoid per-frame allocation
const _tmpVec = new THREE.Vector3();
const _tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');

// Diagnostic counters
let _frameCount = 0;
let _lastDiagTime = 0;

// ============================================================
// Entry point — called from shell.html after Module is ready
// ============================================================
export async function start() {
    console.log('[R15] Three.js renderer starting…');
    console.log('[R15] THREE.REVISION =', THREE.REVISION);

    initRenderer();
    initScene();
    initLights();
    initTerrain();
    initBuildings();
    initPlayers();
    initProjectiles();
    initFlags();
    initParticles();
    initStateViews();

    window.addEventListener('resize', onResize);
    onResize();

    console.log('[R15] Init complete. Entering render loop.');
    requestAnimationFrame(loop);
}

// ============================================================
// Renderer + scene + camera
// ============================================================
function initRenderer() {
    const canvas = document.getElementById('canvas');
    renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    canvas.style.visibility = 'visible';
}

function initScene() {
    scene = new THREE.Scene();

    // Sky: vertical gradient via large inverted sphere with vertex-colored material
    const skyGeo = new THREE.SphereGeometry(4000, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
            topColor:    { value: new THREE.Color(0x5A6A7A) },   // zenith
            bottomColor: { value: new THREE.Color(0xB8C4C8) },   // horizon
            offset:      { value: 50.0 },
            exponent:    { value: 0.7 }
        },
        vertexShader: `
            varying vec3 vWorldPos;
            void main(){
                vec4 wp = modelMatrix * vec4(position, 1.0);
                vWorldPos = wp.xyz;
                gl_Position = projectionMatrix * viewMatrix * wp;
            }`,
        fragmentShader: `
            uniform vec3 topColor;
            uniform vec3 bottomColor;
            uniform float offset;
            uniform float exponent;
            varying vec3 vWorldPos;
            void main(){
                float h = normalize(vWorldPos + vec3(0.0, offset, 0.0)).y;
                gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
            }`
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    scene.add(sky);

    // Linear fog matches the C++ horizon color so distant geometry blends to sky
    scene.fog = new THREE.Fog(0xB8C4C8, 600, 1500);

    // Camera — FOV will be updated each frame from g_fov export
    const aspect = window.innerWidth / window.innerHeight;
    camera = new THREE.PerspectiveCamera(90, aspect, 0.5, 5000);
    camera.position.set(0, 50, 0);
    scene.add(camera);
}

function initLights() {
    // Hemisphere ambient — sky light from above + warm bounce from below
    hemiLight = new THREE.HemisphereLight(0xb8c4d8, 0x6a5a3a, 0.55);
    scene.add(hemiLight);

    // Directional sun — matches C++ sun direction (0.4, 0.8, 0.3)
    sunLight = new THREE.DirectionalLight(0xfff4e0, 1.1);
    sunLight.position.set(800, 1600, 600);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.near = 100;
    sunLight.shadow.camera.far = 4000;
    const s = 1500;
    sunLight.shadow.camera.left = -s;
    sunLight.shadow.camera.right = s;
    sunLight.shadow.camera.top = s;
    sunLight.shadow.camera.bottom = -s;
    sunLight.shadow.bias = -0.0005;
    scene.add(sunLight);
    scene.add(sunLight.target);
}

// ============================================================
// Terrain — heightmap-displaced plane
// ============================================================
function initTerrain() {
    const ptr = Module._getHeightmapPtr();
    const size = Module._getHeightmapSize();           // 257
    const worldScale = Module._getHeightmapWorldScale(); // 8.0
    const heights = new Float32Array(Module.HEAPF32.buffer, ptr, size * size);

    const span = (size - 1) * worldScale; // 256 * 8 = 2048
    const segs = size - 1;                // 256 segments → 257 vertices per side

    const geom = new THREE.PlaneGeometry(span, span, segs, segs);
    geom.rotateX(-Math.PI / 2); // PlaneGeometry is XY by default; flip to XZ

    // Displace vertices by heightmap. Layout: vertex (i, j) → index j*size + i.
    // PlaneGeometry vertex index mapping: row j (along Z) × (segs+1) + column i (along X).
    // C++ heightmap layout: RAINDANCE_HEIGHTS[iz][ix] → linear index iz*size + ix.
    // Both match.
    const pos = geom.attributes.position;
    for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
            const linear = j * size + i;
            // Three.js plane vertex order: row 0 is at +Z (top), row size-1 at -Z (bottom)
            // We need row j (0 = -Z far north) so flip Z if needed. Empirically: see below.
            const vIdx = j * size + i;
            pos.setY(vIdx, heights[linear]);
        }
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
        color: 0x8a7a5a,           // muted sand/grass tan
        roughness: 0.95,
        metalness: 0.0,
        flatShading: false,
    });
    terrainMesh = new THREE.Mesh(geom, mat);
    terrainMesh.receiveShadow = true;
    scene.add(terrainMesh);
    console.log('[R15] Terrain built:', size + 'x' + size, 'span=' + span + 'm');
}

// ============================================================
// Buildings — read from C++ array once
// ============================================================
function initBuildings() {
    const ptr = Module._getBuildingPtr();
    const count = Module._getBuildingCount();
    const stride = Module._getBuildingStride();
    const view = new Float32Array(Module.HEAPF32.buffer, ptr, count * stride);

    for (let b = 0; b < count; b++) {
        const o = b * stride;
        const px = view[o], py = view[o+1], pz = view[o+2];
        const hx = view[o+3], hy = view[o+4], hz = view[o+5];
        const type = view[o+6];
        const isRock = (type === 5);
        const cr = view[o+10], cg = view[o+11], cb = view[o+12];

        // Skip rocks for now — they have no collision and would clutter the scene
        if (isRock) continue;

        const geom = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
        const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(cr, cg, cb),
            roughness: 0.85,
            metalness: 0.05,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(px, py + hy * 0.5, pz);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);
        buildingMeshes.push(mesh);
    }
    console.log('[R15] Buildings:', buildingMeshes.length, 'rendered (rocks skipped)');
}

// ============================================================
// Players — capsule placeholders, one per slot
// ============================================================
function initPlayers() {
    for (let i = 0; i < MAX_PLAYERS; i++) {
        const geom = new THREE.CapsuleGeometry(0.6, 1.4, 4, 8);
        const mat = new THREE.MeshStandardMaterial({
            color: 0x808080,
            roughness: 0.5,
            metalness: 0.4,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.visible = false;
        scene.add(mesh);
        playerMeshes.push(mesh);
    }
    console.log('[R15] Players: 16 capsule placeholders');
}

// ============================================================
// Projectiles — sphere placeholders, one per slot
// ============================================================
function initProjectiles() {
    for (let i = 0; i < MAX_PROJECTILES; i++) {
        const geom = new THREE.SphereGeometry(0.25, 8, 6);
        const mat = new THREE.MeshBasicMaterial({ color: 0xFFFFFF });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.visible = false;
        scene.add(mesh);
        projectileMeshes.push(mesh);
    }
    console.log('[R15] Projectiles: 256 sphere placeholders');
}

// ============================================================
// Flags — pole + banner placeholder
// ============================================================
function initFlags() {
    for (let i = 0; i < 2; i++) {
        const group = new THREE.Group();
        // Pole
        const poleGeom = new THREE.CylinderGeometry(0.06, 0.06, 4, 6);
        const poleMat = new THREE.MeshStandardMaterial({ color: 0x808080, metalness: 0.6, roughness: 0.4 });
        const pole = new THREE.Mesh(poleGeom, poleMat);
        pole.position.y = 2;
        pole.castShadow = true;
        group.add(pole);
        // Banner
        const bannerGeom = new THREE.PlaneGeometry(1.5, 0.9);
        const bannerMat = new THREE.MeshStandardMaterial({
            color: TEAM_COLORS[i],
            roughness: 0.85,
            side: THREE.DoubleSide,
        });
        const banner = new THREE.Mesh(bannerGeom, bannerMat);
        banner.position.set(0.75, 3.3, 0);
        group.add(banner);
        scene.add(group);
        flagMeshes.push(group);
    }
    console.log('[R15] Flags: 2 pole+banner placeholders');
}

// ============================================================
// Particles — single THREE.Points system, attribute-driven
// ============================================================
function initParticles() {
    particleGeom = new THREE.BufferGeometry();
    particlePositions = new Float32Array(MAX_PARTICLES * 3);
    particleColors = new Float32Array(MAX_PARTICLES * 3);
    particleSizes = new Float32Array(MAX_PARTICLES);
    particleGeom.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
    particleGeom.setAttribute('color', new THREE.BufferAttribute(particleColors, 3));
    particleGeom.setAttribute('size', new THREE.BufferAttribute(particleSizes, 1));

    const mat = new THREE.PointsMaterial({
        size: 0.4,
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
    });
    particlePoints = new THREE.Points(particleGeom, mat);
    particlePoints.frustumCulled = false; // positions change every frame
    scene.add(particlePoints);
    console.log('[R15] Particles: 1024 THREE.Points');
}

// ============================================================
// Build typed-array views into WASM linear memory.
// Called once after init; reused every frame. ALLOW_MEMORY_GROWTH=0
// guarantees the underlying ArrayBuffer never detaches.
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

    console.log('[R15] State views: player(' + playerStride + ') proj(' + projectileStride +
                ') part(' + particleStride + ') flag(' + flagStride + ')');
}

// ============================================================
// Per-frame sync — read WASM state into Three.js objects
// ============================================================
function syncPlayers() {
    const localIdx = Module._getLocalPlayerIdx();
    const count = Module._getPlayerStateCount();
    for (let i = 0; i < count; i++) {
        const o = i * playerStride;
        const visible = playerView[o + 18] > 0.5;
        const alive   = playerView[o + 13] > 0.5;
        const team    = playerView[o + 11] | 0;
        const mesh = playerMeshes[i];
        // Hide local player in first-person view (camera is at their head)
        if (i === localIdx) {
            mesh.visible = false;
            continue;
        }
        mesh.visible = visible && alive;
        if (!mesh.visible) continue;

        mesh.position.set(playerView[o], playerView[o+1] + 1.2, playerView[o+2]);
        // Apply only yaw to the player body (pitch is for the camera/head)
        mesh.rotation.set(0, playerView[o + 4], 0, 'YXZ');

        // Team color update (skip if unchanged would need cache; small cost so just set)
        const targetColor = TEAM_COLORS[team] ?? TEAM_COLORS[2];
        if (mesh.material.color.getHex() !== targetColor) {
            mesh.material.color.setHex(targetColor);
        }
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
        mesh.position.set(projectileView[o], projectileView[o+1], projectileView[o+2]);
        const type = projectileView[o + 6] | 0;
        const color = PROJ_COLORS[type] ?? 0xFFFFFF;
        if (mesh.material.color.getHex() !== color) {
            mesh.material.color.setHex(color);
        }
    }
}

function syncFlags() {
    for (let i = 0; i < 2; i++) {
        const o = i * flagStride;
        const group = flagMeshes[i];
        const state = flagView[o + 4] | 0; // 0=base, 1=carried, 2=dropped
        group.position.set(flagView[o], flagView[o+1], flagView[o+2]);
        // Hide pole when carried (carrier has the banner attached visually)
        // For R15 placeholder, just keep it visible everywhere.
        group.visible = true;
        // Slight rotation animation
        group.children[1].rotation.y = performance.now() * 0.001;
        // Dimmer when not at home
        group.children[1].material.opacity = state === 0 ? 1.0 : 0.7;
        group.children[1].material.transparent = state !== 0;
    }
}

function syncParticles() {
    let activeCount = 0;
    for (let i = 0; i < MAX_PARTICLES; i++) {
        const o = i * particleStride;
        const age = particleView[o + 7];
        if (age <= 0) continue;
        const dst = activeCount * 3;
        particlePositions[dst]     = particleView[o];
        particlePositions[dst + 1] = particleView[o + 1];
        particlePositions[dst + 2] = particleView[o + 2];
        const type = particleView[o + 6] | 0;
        // type: 0=jet (orange), 3=explosion (orange-red), else white
        if (type === 0 || type === 3) {
            particleColors[dst]     = 1.0;
            particleColors[dst + 1] = 0.55;
            particleColors[dst + 2] = 0.10;
        } else {
            particleColors[dst]     = 0.9;
            particleColors[dst + 1] = 0.9;
            particleColors[dst + 2] = 1.0;
        }
        particleSizes[activeCount] = Math.min(0.5, age * 0.5);
        activeCount++;
    }
    particleGeom.setDrawRange(0, activeCount);
    particleGeom.attributes.position.needsUpdate = true;
    particleGeom.attributes.color.needsUpdate = true;
    particleGeom.attributes.size.needsUpdate = true;
}

function syncCamera() {
    const localIdx = Module._getLocalPlayerIdx();
    const o = localIdx * playerStride;
    const px = playerView[o], py = playerView[o + 1], pz = playerView[o + 2];
    const pitch = playerView[o + 3];
    const yaw   = playerView[o + 4];

    camera.position.set(px, py + 1.7, pz); // eye height 1.7m above feet
    camera.rotation.set(pitch, yaw, 0, 'YXZ');

    // FOV may have been changed via settings menu
    const fov = Module._getCameraFov();
    if (Math.abs(camera.fov - fov) > 0.5) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
    }

    // Sun light follows camera so shadow map covers the active area
    sunLight.position.set(px + 800, 1600, pz + 600);
    sunLight.target.position.set(px, py, pz);
    sunLight.target.updateMatrixWorld();
}

// ============================================================
// Render loop
// ============================================================
function loop() {
    if (!Module._isReady || !Module._isReady()) {
        requestAnimationFrame(loop);
        return;
    }

    // 1. Advance C++ simulation by one frame
    Module._tick();

    // 2. Read fresh state into Three.js scene
    syncPlayers();
    syncProjectiles();
    syncFlags();
    syncParticles();
    syncCamera();

    // 3. Render
    renderer.render(scene, camera);

    // 4. Diagnostic: log frame stats every 5s
    _frameCount++;
    const now = performance.now();
    if (now - _lastDiagTime > 5000) {
        const fps = Math.round(_frameCount / ((now - _lastDiagTime) / 1000));
        const info = renderer.info.render;
        console.log('[R15] ' + fps + 'fps, ' + info.calls + ' draw calls, ' + info.triangles + ' tris');
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
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Make canvas fill the viewport instead of the fixed 1024x768 from the legacy renderer
    const canvas = document.getElementById('canvas');
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.style.transform = 'none';
    canvas.style.top = '0';
    canvas.style.left = '0';
}
