/**
 * @ai-contract
 * MODULE: renderer_particles.js
 * PURPOSE: Unified particle systems — ski sparks, projectile trails, explosion FX, WASM-synced particles, night fairies, jet exhaust
 * IMPORTS: Three.js
 * EXPORTS: { init, update, dispose, emit, triggerExplosion, syncWASMParticles }
 * EXPOSES: window.__generatorPositions (via interior lights — NOT in this module)
 * LIFECYCLE: init(deps) → update(dt, t) per frame → emit(type, pos, params) on events → dispose() on teardown
 * OWNER: Aliveness (particles are visual feedback for movement, combat, atmosphere)
 * EXTRACTED FROM: renderer.js R32.233 (was lines ~3335-4860)
 * JET_EXHAUST: R32.272 — two-layer bone-attached system (core glow + wake trail).
 *   Requires deps.getJetBonePos(idx, armor, outVec3) for bone attachment.
 *   Falls back to playerView position + yaw offset if bone unavailable.
 *   Quality: LOW = core only, MEDIUM+ = core + wake.
 */

import * as THREE from 'three';

// ============================================================
// Parameterized Point Pool — one class, many effects
// ============================================================
class PointPool {
    /**
     * @param {object} config
     * @param {number} config.maxCount - pool size
     * @param {number} config.lifetime - default lifetime in seconds
     * @param {boolean} [config.hasVelocity=true] - track velocity per particle
     * @param {boolean} [config.hasColor=false] - per-particle RGB
     * @param {number} [config.gravity=0] - downward acceleration (m/s²)
     * @param {number} [config.drag=1.0] - velocity multiplier per frame (0.96 = light drag)
     * @param {number} [config.pointSizeMultiplier=120] - shader point size scale
     * @param {string} config.vertexShader - custom vertex shader (optional)
     * @param {string} config.fragmentShader - custom fragment shader (optional)
     * @param {number} [config.renderOrder=100]
     */
    constructor(config) {
        this.max = config.maxCount;
        this.lifetime = config.lifetime;
        this.gravity = config.gravity || 0;
        this.drag = config.drag !== undefined ? config.drag : 1.0;
        this.hasVelocity = config.hasVelocity !== false;
        this.hasColor = config.hasColor || false;
        this.nextSlot = 0;
        this.points = null;

        // SoA arrays
        this.pos   = new Float32Array(this.max * 3);
        this.age   = new Float32Array(this.max);
        this.alpha = new Float32Array(this.max);
        if (this.hasVelocity) this.vel = new Float32Array(this.max * 3);
        if (this.hasColor) this.color = new Float32Array(this.max * 3);

        // Init dead
        for (let i = 0; i < this.max; i++) {
            this.pos[i * 3 + 1] = -9999;
            this.alpha[i] = 0;
            if (this.hasColor) {
                this.color[i * 3] = 1;
                this.color[i * 3 + 1] = 1;
                this.color[i * 3 + 2] = 1;
            }
        }

        // Geometry
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('aAlpha', new THREE.Float32BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
        if (this.hasColor) {
            geo.setAttribute('aColor', new THREE.Float32BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
        }

        // Shader
        const psm = config.pointSizeMultiplier || 120;
        const defaultVS = this.hasColor ? `
            attribute float aAlpha;
            attribute vec3 aColor;
            varying float vAlpha;
            varying vec3 vColor;
            void main() {
                vAlpha = aAlpha;
                vColor = aColor;
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = aAlpha * ${psm.toFixed(1)} / max(1.0, -mv.z);
                gl_Position = projectionMatrix * mv;
            }
        ` : `
            attribute float aAlpha;
            varying float vAlpha;
            void main() {
                vAlpha = aAlpha;
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = aAlpha * ${psm.toFixed(1)} / max(1.0, -mv.z);
                gl_Position = projectionMatrix * mv;
            }
        `;

        const mat = new THREE.ShaderMaterial({
            uniforms: config.uniforms || {},
            vertexShader: config.vertexShader || defaultVS,
            fragmentShader: config.fragmentShader || `
                varying float vAlpha;
                void main() {
                    float r = length(gl_PointCoord - vec2(0.5));
                    if (r > 0.5) discard;
                    float soft = 1.0 - smoothstep(0.2, 0.5, r);
                    gl_FragColor = vec4(1.0, 1.0, 1.0, soft * vAlpha);
                }
            `,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });

        this.points = new THREE.Points(geo, mat);
        this.points.frustumCulled = false;
        this.points.renderOrder = config.renderOrder || 100;
    }

    addToScene(scene) {
        scene.add(this.points);
    }

    emit(wx, wy, wz, vx, vy, vz, lifetime, alpha, r, g, b) {
        // Scan for dead slot
        for (let t = 0; t < 16; t++) {
            if (this.age[this.nextSlot] <= 0) break;
            this.nextSlot = (this.nextSlot + 1) % this.max;
        }
        const i = this.nextSlot;
        this.pos[i*3]   = wx;
        this.pos[i*3+1] = wy;
        this.pos[i*3+2] = wz;
        if (this.hasVelocity) {
            this.vel[i*3]   = vx || 0;
            this.vel[i*3+1] = vy || 0;
            this.vel[i*3+2] = vz || 0;
        }
        this.age[i]   = lifetime || this.lifetime;
        this.alpha[i] = alpha !== undefined ? alpha : (0.7 + Math.random() * 0.3);
        if (this.hasColor && r !== undefined) {
            this.color[i*3]   = r;
            this.color[i*3+1] = g;
            this.color[i*3+2] = b;
        }
        this.nextSlot = (this.nextSlot + 1) % this.max;
    }

    tick(dt) {
        for (let i = 0; i < this.max; i++) {
            if (this.age[i] <= 0) continue;
            this.age[i] -= dt;
            if (this.age[i] <= 0) {
                this.age[i] = 0;
                this.pos[i*3+1] = -9999;
                this.alpha[i] = 0;
                continue;
            }
            if (this.hasVelocity) {
                this.pos[i*3]   += this.vel[i*3]   * dt;
                this.pos[i*3+1] += this.vel[i*3+1] * dt;
                this.pos[i*3+2] += this.vel[i*3+2] * dt;
                this.vel[i*3+1] -= this.gravity * dt;
                if (this.drag < 1.0) {
                    this.vel[i*3]   *= this.drag;
                    this.vel[i*3+2] *= this.drag;
                }
            }
            const life = this.age[i] / this.lifetime;
            this.alpha[i] = life < 0.6 ? life / 0.6 : 1.0;
        }
        this.points.geometry.attributes.position.needsUpdate = true;
        this.points.geometry.attributes.aAlpha.needsUpdate = true;
        if (this.hasColor) {
            this.points.geometry.attributes.aColor.needsUpdate = true;
        }
    }

    dispose() {
        if (this.points) {
            this.points.geometry.dispose();
            this.points.material.dispose();
            if (this.points.parent) this.points.parent.remove(this.points);
            this.points = null;
        }
    }
}

// ============================================================
// Module state
// ============================================================
let _scene = null;
let _camera = null;
let _deps = null; // { playerView, playerStride, projectileView, projectileStride, particleView, particleStride, ... }

// Unified pools
let _skiPool = null;
let _trailPool = null;
let _sparkPool = null;

// Jet exhaust (R32.272) — two-layer system: core glow + wake trail
let _jetCore = null;     // { points, pos, alpha, size, color }
let _jetWake = null;     // { points, pos, vel, age, maxAge, alpha, size, color, teamIdx, nextSlot }
const _jetState = [];    // per-player: { wasJetting, jetStartTime }
const _JET_MAX_CORE = 16;
const _JET_MAX_WAKE = 192;

// Jet exhaust team colors [R, G, B] — from Ive's design spec
const _JET_TEAM_COLORS = [
    { // 0: Blood Eagle
        coreFringe: [1.0, 0.42, 0.21],  wakeBorn: [1.0, 0.55, 0.26],  wakeTerm: [0.55, 0.48, 0.42],
    },
    { // 1: Diamond Sword
        coreFringe: [0.30, 0.65, 1.0],  wakeBorn: [0.42, 0.72, 1.0],  wakeTerm: [0.48, 0.55, 0.55],
    },
    { // 2: Phoenix
        coreFringe: [1.0, 0.70, 0.0],   wakeBorn: [1.0, 0.80, 0.27],  wakeTerm: [0.55, 0.52, 0.41],
    },
    { // 3: Starwolf
        coreFringe: [0.40, 1.0, 0.40],  wakeBorn: [0.53, 1.0, 0.53],  wakeTerm: [0.48, 0.55, 0.48],
    },
];
const _JET_CORE_WHITE = [1.0, 0.98, 0.94]; // #FFFAF0 hot white

// Unified pools
let _skiPool = null;
let _trailPool = null;
let _sparkPool = null;

// WASM-synced particles (legacy — reads from HEAPF32)
let _wasmParticleSystem = null;
let _wasmParticleGeom = null;
let _wasmPositions = null;
let _wasmColors = null;
let _wasmSizes = null;
let _prevParticleAge = null;

// Explosion fireballs (mesh-based, not point sprites)
const EXPL_POOL = 8;
const EXPL_LIFETIME = 0.55;
const SPARKS_PER_EXPLOSION = 24;
let _explPool = null;

// Night fairies (GPU-driven)
let _nfPoints = null;
let _nfHeightTex = null;

// Trail color lookup
const _TRAIL_RGB = [
    [1.0, 1.0, 1.0],   // 0 blaster
    [1.0, 0.93, 0.25],  // 1 chaingun
    [0.7, 0.85, 1.0],   // 2 disc
    [0.3, 0.5, 0.19],   // 3 grenade
    [1.0, 0.38, 0.13],  // 4 plasma
    [1.0, 0.63, 0.25],  // 5 mortar
    [1.0, 0.25, 0.25],  // 6
    [0.5, 0.63, 1.0],   // 7
    [0.25, 1.0, 0.5],   // 8
];


// ============================================================
// Soft circle texture (shared by WASM particle system)
// ============================================================
function _makeSoftCircleTexture() {
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

// ============================================================
// Public API
// ============================================================

/**
 * Initialize all particle systems.
 * @param {object} deps
 * @param {THREE.Scene} deps.scene
 * @param {THREE.Camera} deps.camera
 * @param {number} deps.MAX_PARTICLES
 * @param {number} deps.MAX_PLAYERS
 * @param {number} deps.MAX_PROJECTILES
 * @param {Function} deps.getPlayerView - () => { view, stride }
 * @param {Function} deps.getProjectileView - () => { view, stride }
 * @param {Function} deps.getParticleView - () => { view, stride }
 * @param {Function} deps.getQualityTier - () => tier object
 * @param {Function} deps.sampleTerrainH - (x,z) => height
 * @param {Float32Array} deps.htData - heightmap data
 * @param {number} deps.htSize - heightmap size
 * @param {number} deps.htScale - heightmap scale
 */
export function init(deps) {
    _scene = deps.scene;
    _camera = deps.camera;
    _deps = deps;

    // --- Ski particles ---
    _skiPool = new PointPool({
        maxCount: 256,
        lifetime: 0.45,
        hasVelocity: true,
        gravity: 3.0,
        drag: 0.96,
        pointSizeMultiplier: 120,
        renderOrder: 100,
        fragmentShader: `
            varying float vAlpha;
            void main() {
                float r = length(gl_PointCoord - vec2(0.5));
                if (r > 0.5) discard;
                float soft = 1.0 - smoothstep(0.2, 0.5, r);
                vec3 col = mix(vec3(0.8, 0.95, 1.0), vec3(0.3, 0.6, 1.0), r * 2.0);
                gl_FragColor = vec4(col, soft * vAlpha);
            }
        `,
    });
    _skiPool.addToScene(_scene);

    // --- Projectile trails ---
    _trailPool = new PointPool({
        maxCount: 512,
        lifetime: 0.25,
        hasVelocity: false,
        hasColor: true,
        pointSizeMultiplier: 180,
        renderOrder: 101,
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
    });
    _trailPool.addToScene(_scene);

    // --- Explosion sparks ---
    _sparkPool = new PointPool({
        maxCount: EXPL_POOL * SPARKS_PER_EXPLOSION,
        lifetime: 0.55,
        hasVelocity: true,
        gravity: 12.0,
        drag: 0.98,
        pointSizeMultiplier: 180,
        renderOrder: 96,
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
    });
    _sparkPool.addToScene(_scene);

    // --- WASM-synced particles ---
    _initWASMParticles(deps);

    // --- Explosion fireballs ---
    _initExplosionFireballs();

    // --- Night fairies ---
    if (deps.htData && deps.htSize) {
        _initNightFairies(deps);
    }

    // --- Jet exhaust (R32.272) ---
    _initJetExhaust();

    console.log('[R32.272] Particle systems initialized: ski, trails, sparks, explosions, fairies, jet exhaust');
}

function _initWASMParticles(deps) {
    _wasmParticleGeom = new THREE.BufferGeometry();
    _wasmPositions = new Float32Array(deps.MAX_PARTICLES * 3);
    _wasmColors = new Float32Array(deps.MAX_PARTICLES * 3);
    _wasmSizes = new Float32Array(deps.MAX_PARTICLES);
    _wasmParticleGeom.setAttribute('position', new THREE.BufferAttribute(_wasmPositions, 3));
    _wasmParticleGeom.setAttribute('color', new THREE.BufferAttribute(_wasmColors, 3));
    _wasmParticleGeom.setAttribute('size', new THREE.BufferAttribute(_wasmSizes, 1));

    const mat = new THREE.PointsMaterial({
        size: 0.6,
        map: _makeSoftCircleTexture(),
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
        alphaTest: 0.01,
    });
    _wasmParticleSystem = new THREE.Points(_wasmParticleGeom, mat);
    _wasmParticleSystem.frustumCulled = false;
    _scene.add(_wasmParticleSystem);
}

function _initExplosionFireballs() {
    _explPool = [];
    for (let i = 0; i < EXPL_POOL; i++) {
        const geo = new THREE.SphereGeometry(1.0, 12, 8);
        const mat = new THREE.ShaderMaterial({
            uniforms: { uProgress: { value: 0.0 } },
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
        _scene.add(mesh);
        _explPool.push({ mesh, active: false, age: 0, intensity: 1.0 });
    }
}

function _initNightFairies(deps) {
    const N = 44800;
    const R = 400;
    const ALT_ABOVE = 2;
    const ALT_RANGE = 90;
    const positions = new Float32Array(N * 3);
    const params = new Float32Array(N * 4);
    const colors = new Float32Array(N * 3);

    for (let i = 0; i < N; i++) {
        positions[i*3]   = (Math.random() - 0.5) * R * 2;
        positions[i*3+1] = ALT_ABOVE + Math.random() * ALT_RANGE;
        positions[i*3+2] = (Math.random() - 0.5) * R * 2;
        params[i*4]   = Math.random() * Math.PI * 2;
        params[i*4+1] = 0.2 + Math.random() * 0.6;
        params[i*4+2] = Math.random() * Math.PI * 2;
        params[i*4+3] = Math.random();
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

    // Heightmap texture for GPU terrain sampling
    _nfHeightTex = _createHeightmapTexture(deps.htData, deps.htSize);

    const htSize = deps.htSize || 256;
    const htScale = deps.htScale || 1;
    const htHalf = (htSize - 1) * htScale * 0.5;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('aParams', new THREE.Float32BufferAttribute(params, 4));
    geo.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));

    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uTime: { value: 0 },
            uCamPos: { value: new THREE.Vector3() },
            uRadius: { value: R },
            uOpacity: { value: 1.0 },
            uHeightmap: { value: _nfHeightTex },
            uHtSize: { value: htSize },
            uHtScale: { value: htScale },
            uHtHalf: { value: htHalf },
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
                float wx = position.x + cos(driftAngle) * speed * uTime * 0.3;
                float wz = position.z + sin(driftAngle) * speed * uTime * 0.3;
                float dx = wx - uCamPos.x;
                float dz = wz - uCamPos.z;
                float diameter = uRadius * 2.0;
                dx = dx - diameter * floor((dx + uRadius) / diameter);
                dz = dz - diameter * floor((dz + uRadius) / diameter);
                wx = uCamPos.x + dx;
                wz = uCamPos.z + dz;
                float terrainH = sampleTerrain(wx, wz);
                float wy = terrainH + position.y + sin(uTime * 0.4 + phase) * 3.0;
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
    _scene.add(_nfPoints);
    console.log('[R32.233] Night fairies: N=' + N + ' R=' + R + 'm');
}

function _createHeightmapTexture(htData, htSize) {
    if (!htData || htSize < 2) {
        const d = new Float32Array(4);
        const tex = new THREE.DataTexture(d, 2, 2, THREE.RedFormat, THREE.FloatType);
        tex.needsUpdate = true;
        return tex;
    }
    const tex = new THREE.DataTexture(htData, htSize, htSize, THREE.RedFormat, THREE.FloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
}


    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
}


// ============================================================
// Jet exhaust (R32.272) — Spine1 bone-attached, two-layer design
// Core: persistent bright nozzle glow (sizeAttenuation: false, beacon)
// Wake: short-lived exhaust trail (inverse-velocity, size expansion, color desaturation)
// ============================================================

const _jetEmitPos = new THREE.Vector3();

function _initJetExhaust() {
    // ── Core: 1 persistent point per jetting player ──
    const corePos   = new Float32Array(_JET_MAX_CORE * 3);
    const coreAlpha = new Float32Array(_JET_MAX_CORE);
    const coreSize  = new Float32Array(_JET_MAX_CORE);
    const coreColor = new Float32Array(_JET_MAX_CORE * 3);
    for (let i = 0; i < _JET_MAX_CORE; i++) {
        corePos[i * 3 + 1] = -9999;
        coreAlpha[i] = 0;
        coreSize[i] = 0;
    }
    const coreGeo = new THREE.BufferGeometry();
    coreGeo.setAttribute('position', new THREE.Float32BufferAttribute(corePos, 3).setUsage(THREE.DynamicDrawUsage));
    coreGeo.setAttribute('aAlpha', new THREE.Float32BufferAttribute(coreAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    coreGeo.setAttribute('aSize', new THREE.Float32BufferAttribute(coreSize, 1).setUsage(THREE.DynamicDrawUsage));
    coreGeo.setAttribute('aColor', new THREE.Float32BufferAttribute(coreColor, 3).setUsage(THREE.DynamicDrawUsage));

    const coreMat = new THREE.ShaderMaterial({
        vertexShader: `
            attribute float aAlpha;
            attribute float aSize;
            attribute vec3 aColor;
            varying float vAlpha;
            varying vec3 vColor;
            void main() {
                vAlpha = aAlpha;
                vColor = aColor;
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = aSize;
                gl_Position = projectionMatrix * mv;
            }
        `,
        fragmentShader: `
            varying float vAlpha;
            varying vec3 vColor;
            void main() {
                float r = length(gl_PointCoord - vec2(0.5));
                if (r > 0.5) discard;
                float soft = 1.0 - smoothstep(0.0, 0.5, r);
                vec3 hotWhite = vec3(1.0, 0.98, 0.94);
                vec3 col = mix(vColor, hotWhite, soft * soft);
                gl_FragColor = vec4(col, soft * vAlpha);
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });

    const corePoints = new THREE.Points(coreGeo, coreMat);
    corePoints.frustumCulled = false;
    corePoints.renderOrder = 102;
    _scene.add(corePoints);

    _jetCore = { points: corePoints, pos: corePos, alpha: coreAlpha, size: coreSize, color: coreColor };

    // ── Wake: particle stream with velocity, expansion, desaturation ──
    const wakePos   = new Float32Array(_JET_MAX_WAKE * 3);
    const wakeAlpha = new Float32Array(_JET_MAX_WAKE);
    const wakeSize  = new Float32Array(_JET_MAX_WAKE);
    const wakeColor = new Float32Array(_JET_MAX_WAKE * 3);
    // CPU-only arrays
    const wakeVel     = new Float32Array(_JET_MAX_WAKE * 3);
    const wakeAge     = new Float32Array(_JET_MAX_WAKE);
    const wakeMaxAge  = new Float32Array(_JET_MAX_WAKE);
    const wakeBornR   = new Float32Array(_JET_MAX_WAKE);
    const wakeBornG   = new Float32Array(_JET_MAX_WAKE);
    const wakeBornB   = new Float32Array(_JET_MAX_WAKE);
    const wakeTermR   = new Float32Array(_JET_MAX_WAKE);
    const wakeTermG   = new Float32Array(_JET_MAX_WAKE);
    const wakeTermB   = new Float32Array(_JET_MAX_WAKE);

    for (let i = 0; i < _JET_MAX_WAKE; i++) {
        wakePos[i * 3 + 1] = -9999;
        wakeAlpha[i] = 0;
        wakeAge[i] = 0;
    }

    const wakeGeo = new THREE.BufferGeometry();
    wakeGeo.setAttribute('position', new THREE.Float32BufferAttribute(wakePos, 3).setUsage(THREE.DynamicDrawUsage));
    wakeGeo.setAttribute('aAlpha', new THREE.Float32BufferAttribute(wakeAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    wakeGeo.setAttribute('aSize', new THREE.Float32BufferAttribute(wakeSize, 1).setUsage(THREE.DynamicDrawUsage));
    wakeGeo.setAttribute('aColor', new THREE.Float32BufferAttribute(wakeColor, 3).setUsage(THREE.DynamicDrawUsage));

    const wakeMat = new THREE.ShaderMaterial({
        vertexShader: `
            attribute float aAlpha;
            attribute float aSize;
            attribute vec3 aColor;
            varying float vAlpha;
            varying vec3 vColor;
            void main() {
                vAlpha = aAlpha;
                vColor = aColor;
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = aSize * 120.0 / max(1.0, -mv.z);
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

    const wakePoints = new THREE.Points(wakeGeo, wakeMat);
    wakePoints.frustumCulled = false;
    wakePoints.renderOrder = 99;
    _scene.add(wakePoints);

    _jetWake = {
        points: wakePoints, pos: wakePos, vel: wakeVel,
        age: wakeAge, maxAge: wakeMaxAge,
        alpha: wakeAlpha, size: wakeSize, color: wakeColor,
        bornR: wakeBornR, bornG: wakeBornG, bornB: wakeBornB,
        termR: wakeTermR, termG: wakeTermG, termB: wakeTermB,
        nextSlot: 0,
    };

    // Init per-player jet state
    for (let i = 0; i < 16; i++) {
        _jetState[i] = { wasJetting: false, jetStartTime: 0 };
    }

    console.log('[R32.272] Jet exhaust initialized: core=' + _JET_MAX_CORE + ' wake=' + _JET_MAX_WAKE);
}

function _emitJetWakeParticle(wx, wy, wz, vx, vy, vz, lifetime, bornR, bornG, bornB, termR, termG, termB) {
    if (!_jetWake) return;
    const w = _jetWake;
    // Scan for dead slot
    for (let t = 0; t < 16; t++) {
        if (w.age[w.nextSlot] <= 0) break;
        w.nextSlot = (w.nextSlot + 1) % _JET_MAX_WAKE;
    }
    const i = w.nextSlot;
    w.pos[i*3]   = wx;
    w.pos[i*3+1] = wy;
    w.pos[i*3+2] = wz;
    w.vel[i*3]   = vx;
    w.vel[i*3+1] = vy;
    w.vel[i*3+2] = vz;
    w.age[i]     = lifetime;
    w.maxAge[i]  = lifetime;
    w.alpha[i]   = 0.7;
    w.size[i]    = 0.15;
    w.color[i*3]   = bornR;
    w.color[i*3+1] = bornG;
    w.color[i*3+2] = bornB;
    w.bornR[i] = bornR; w.bornG[i] = bornG; w.bornB[i] = bornB;
    w.termR[i] = termR; w.termG[i] = termG; w.termB[i] = termB;
    w.nextSlot = (w.nextSlot + 1) % _JET_MAX_WAKE;
}

function _tickJetWake(dt) {
    if (!_jetWake) return;
    const w = _jetWake;
    const GRAVITY = 2.0;
    const DRAG = 0.92;
    for (let i = 0; i < _JET_MAX_WAKE; i++) {
        if (w.age[i] <= 0) continue;
        w.age[i] -= dt;
        if (w.age[i] <= 0) {
            w.age[i] = 0;
            w.pos[i*3+1] = -9999;
            w.alpha[i] = 0;
            w.size[i] = 0;
            continue;
        }
        // Normalized age: 0 at born → 1 at death
        const t = 1.0 - (w.age[i] / w.maxAge[i]);
        const sqrtT = Math.sqrt(t);

        // Velocity integration + gravity + drag
        w.vel[i*3+1] -= GRAVITY * dt;
        w.vel[i*3]   *= DRAG;
        w.vel[i*3+1] *= DRAG;
        w.vel[i*3+2] *= DRAG;
        w.pos[i*3]   += w.vel[i*3]   * dt;
        w.pos[i*3+1] += w.vel[i*3+1] * dt;
        w.pos[i*3+2] += w.vel[i*3+2] * dt;

        // Opacity: fast initial fade (0.7→0.15 in first 30%), slow tail (0.15→0 in last 70%)
        if (t < 0.3) {
            w.alpha[i] = 0.7 + (0.15 - 0.7) * (t / 0.3);
        } else {
            w.alpha[i] = 0.15 * (1.0 - (t - 0.3) / 0.7);
        }

        // Size expansion: 0.15 → 0.6 with sqrt curve (fast initial expand)
        w.size[i] = 0.15 + (0.6 - 0.15) * sqrtT;

        // Color desaturation: team color → warm/cool grey
        w.color[i*3]   = w.bornR[i] + (w.termR[i] - w.bornR[i]) * sqrtT;
        w.color[i*3+1] = w.bornG[i] + (w.termG[i] - w.bornG[i]) * sqrtT;
        w.color[i*3+2] = w.bornB[i] + (w.termB[i] - w.bornB[i]) * sqrtT;
    }
    w.points.geometry.attributes.position.needsUpdate = true;
    w.points.geometry.attributes.aAlpha.needsUpdate = true;
    w.points.geometry.attributes.aSize.needsUpdate = true;
    w.points.geometry.attributes.aColor.needsUpdate = true;
}

function _updateJetExhaust(dt, t) {
    if (!_jetCore || !_deps) return;
    const pv = _deps.getPlayerView();
    if (!pv) return;
    const { view: playerView, stride: playerStride } = pv;
    const maxPlayers = _deps.MAX_PLAYERS || 16;
    const isLowQuality = _deps.getQualityTier && _deps.getQualityTier().particleCap <= 256;

    for (let p = 0; p < maxPlayers; p++) {
        const o = p * playerStride;
        const visible = playerView[o + 18] > 0.5;
        const alive   = playerView[o + 13] > 0.5;
        const jetting = playerView[o + 14] > 0.5;
        const teamIdx = (playerView[o + 11] | 0);
        const armor   = (playerView[o + 12] | 0);
        const vx = playerView[o + 6];
        const vy = playerView[o + 7];
        const vz = playerView[o + 8];
        const yaw = playerView[o + 4];
        const speed = Math.sqrt(vx*vx + vy*vy + vz*vz);

        const st = _jetState[p] || (_jetState[p] = { wasJetting: false, jetStartTime: 0 });
        const isJetting = visible && alive && jetting;

        // Detect ignition (jet just started)
        if (isJetting && !st.wasJetting) {
            st.jetStartTime = t;
        }
        st.wasJetting = isJetting;

        // ── Core update ──
        if (isJetting) {
            // Get emission position: try bone, fall back to playerView + offset
            let gotBone = false;
            if (_deps.getJetBonePos) {
                gotBone = _deps.getJetBonePos(p, armor, _jetEmitPos);
            }
            if (!gotBone) {
                // Fallback: player position + yaw-based back offset + spine height
                const rotY = -yaw + Math.PI;
                const dist = [0.25, 0.30, 0.38][armor] || 0.30;
                _jetEmitPos.set(
                    playerView[o] - Math.sin(rotY) * dist,
                    playerView[o + 1] - 1.0, // approx spine1 height
                    playerView[o + 2] - Math.cos(rotY) * dist
                );
            }

            // Core position
            _jetCore.pos[p*3]   = _jetEmitPos.x;
            _jetCore.pos[p*3+1] = _jetEmitPos.y;
            _jetCore.pos[p*3+2] = _jetEmitPos.z;
            _jetCore.alpha[p] = 1.0;

            // Core color: 80% hot white + 20% team fringe
            const tc = _JET_TEAM_COLORS[teamIdx] || _JET_TEAM_COLORS[0];
            _jetCore.color[p*3]   = _JET_CORE_WHITE[0] * 0.8 + tc.coreFringe[0] * 0.2;
            _jetCore.color[p*3+1] = _JET_CORE_WHITE[1] * 0.8 + tc.coreFringe[1] * 0.2;
            _jetCore.color[p*3+2] = _JET_CORE_WHITE[2] * 0.8 + tc.coreFringe[2] * 0.2;

            // Core size: ignition snap → hover pulse → steady thrust
            const jetAge = t - st.jetStartTime;
            let coreSize = 12.0;
            if (jetAge < 0.1) {
                // Ignition: 1.4× for first 100ms, ease back
                const ignT = jetAge / 0.1;
                coreSize = 12.0 * (1.4 - 0.4 * ignT * ignT); // quadratic ease-out
            } else if (speed < 3.0) {
                // Hover: gentle 3.5Hz pulse ±8%
                coreSize = 12.0 * (1.0 + 0.08 * Math.sin(t * 3.5 * 6.2832));
            }
            // else: full thrust = steady 12px
            _jetCore.size[p] = coreSize;

            // ── Wake emission (skip on LOW quality) ──
            if (!isLowQuality && _jetWake) {
                const emRate = (jetAge < 0.1) ? 100 : 35; // 3× during ignition burst
                const emitCount = Math.floor(emRate * dt + Math.random()); // stochastic

                for (let e = 0; e < emitCount; e++) {
                    // Emit velocity: inverse of player velocity + downward bias
                    let evx, evy, evz;
                    if (speed > 0.5) {
                        const invSpeed = 4.0 / speed;
                        evx = -vx * invSpeed + (Math.random() - 0.5) * 0.5;
                        evy = -vy * invSpeed - 1.5 + (Math.random() - 0.5) * 0.3;
                        evz = -vz * invSpeed + (Math.random() - 0.5) * 0.5;
                    } else {
                        // Hovering: mostly downward
                        evx = (Math.random() - 0.5) * 1.0;
                        evy = -3.0 + (Math.random() - 0.5) * 0.5;
                        evz = (Math.random() - 0.5) * 1.0;
                    }
                    const lifetime = 0.25 + Math.random() * 0.10; // 0.25-0.35s
                    _emitJetWakeParticle(
                        _jetEmitPos.x + (Math.random()-0.5) * 0.08,
                        _jetEmitPos.y + (Math.random()-0.5) * 0.08,
                        _jetEmitPos.z + (Math.random()-0.5) * 0.08,
                        evx, evy, evz, lifetime,
                        tc.wakeBorn[0], tc.wakeBorn[1], tc.wakeBorn[2],
                        tc.wakeTerm[0], tc.wakeTerm[1], tc.wakeTerm[2]
                    );
                }
            }
        } else {
            // Jets OFF: instant snap to zero — no fade
            _jetCore.pos[p*3+1] = -9999;
            _jetCore.alpha[p] = 0;
            _jetCore.size[p] = 0;
        }
    }

    // Update core GPU buffers
    _jetCore.points.geometry.attributes.position.needsUpdate = true;
    _jetCore.points.geometry.attributes.aAlpha.needsUpdate = true;
    _jetCore.points.geometry.attributes.aSize.needsUpdate = true;
    _jetCore.points.geometry.attributes.aColor.needsUpdate = true;

    // Tick wake particles
    _tickJetWake(dt);
}

function _disposeJetExhaust() {
    if (_jetCore) {
        _jetCore.points.geometry.dispose();
        _jetCore.points.material.dispose();
        if (_jetCore.points.parent) _jetCore.points.parent.remove(_jetCore.points);
        _jetCore = null;
    }
    if (_jetWake) {
        _jetWake.points.geometry.dispose();
        _jetWake.points.material.dispose();
        if (_jetWake.points.parent) _jetWake.points.parent.remove(_jetWake.points);
        _jetWake = null;
    }
    _jetState.length = 0;
}


// ============================================================
// Per-frame update
// ============================================================

/**
 * Update all particle systems.
 * @param {number} dt - delta time
 * @param {number} t - absolute time (performance.now() * 0.001)
 */
export function update(dt, t) {
    // Ski particles: tick + emit from skiing players
    if (_skiPool) {
        _skiPool.tick(dt);
        _emitSkiParticles();
    }

    // Projectile trails: tick + emit from active projectiles
    if (_trailPool) {
        _trailPool.tick(dt);
        _emitTrailParticles();
    }

    // Explosion sparks
    if (_sparkPool) _sparkPool.tick(dt);

    // Explosion fireballs
    _updateExplosionFireballs(dt);

    // Night fairies
    if (_nfPoints && _camera) {
        _nfPoints.visible = true;
        const u = _nfPoints.material.uniforms;
        u.uTime.value = t;
        u.uCamPos.value.copy(_camera.position);
        u.uOpacity.value = 1.0;
    }

    // R32.272: Jet exhaust — bone-attached, two-layer
    _updateJetExhaust(dt, t);
}

/**
 * Sync WASM-driven particle state (reads from HEAPF32).
 * Called separately because it needs Module and polish references.
 * @param {object} ctx - { particleView, particleStride, MAX_PARTICLES, qualityTier, scene, camera, polish, Polish, fovPunchCallback }
 */
export function syncWASMParticles(ctx) {
    if (!_wasmParticleSystem || !ctx.particleView) return;
    const { particleView, particleStride, MAX_PARTICLES, qualityTier } = ctx;
    const cap = qualityTier.particleCap || MAX_PARTICLES;
    let activeCount = 0;
    if (!_prevParticleAge) _prevParticleAge = new Float32Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES && activeCount < cap; i++) {
        const o = i * particleStride;
        const age = particleView[o + 7];
        const prevAge = _prevParticleAge[i];
        if (age > 0 && prevAge <= 0) {
            const ptype = particleView[o + 6] | 0;
            if (ptype === 3 && ctx.polish && ctx.Polish && ctx.Polish.spawnShockwave) {
                try {
                    const px = particleView[o], py = particleView[o + 1], pz = particleView[o + 2];
                    ctx.Polish.spawnShockwave(ctx.scene, new THREE.Vector3(px, py, pz), 1.0);
                    triggerExplosion(px, py, pz, 1.0);
                    if (ctx.fovPunchCallback) {
                        const dx = px - ctx.camera.position.x, dy = py - ctx.camera.position.y, dz = pz - ctx.camera.position.z;
                        if (dx * dx + dy * dy + dz * dz < 900) ctx.fovPunchCallback(2.5);
                    }
                } catch (e) {}
            }
        }
        _prevParticleAge[i] = age;
        if (age <= 0) continue;
        const type = particleView[o + 6] | 0;
        if (type === 0 || type === 1 || type === 2) continue;
        const dst = activeCount * 3;
        _wasmPositions[dst]     = particleView[o];
        _wasmPositions[dst + 1] = particleView[o + 1];
        _wasmPositions[dst + 2] = particleView[o + 2];
        let r, g, b, sz;
        if (type === 0)      { const ageT = Math.min(1, age * 2); r = 1.0; g = 0.4 + ageT * 0.5; b = 0.05 + (1 - ageT) * 0.6; sz = 0.45; }
        else if (type === 3) { r = 1.0; g = 0.55; b = 0.15; sz = 0.7; }
        else if (type === 4) { r = 1.0; g = 0.85; b = 0.4; sz = 0.30; }
        else                 { r = 0.9; g = 0.85; b = 0.7; sz = 0.35; }
        _wasmColors[dst]     = r;
        _wasmColors[dst + 1] = g;
        _wasmColors[dst + 2] = b;
        _wasmSizes[activeCount] = Math.min(sz, age * sz);
        activeCount++;
    }
    _wasmParticleGeom.setDrawRange(0, activeCount);
    _wasmParticleGeom.attributes.position.needsUpdate = true;
    _wasmParticleGeom.attributes.color.needsUpdate = true;
    _wasmParticleGeom.attributes.size.needsUpdate = true;
}

function _emitSkiParticles() {
    if (!_deps) return;
    const pv = _deps.getPlayerView();
    if (!pv) return;
    const { view: playerView, stride: playerStride } = pv;
    for (let p = 0; p < _deps.MAX_PLAYERS; p++) {
        const o = p * playerStride;
        if (playerView[o + 18] < 0.5) continue;
        if (playerView[o + 13] < 0.5) continue;
        if (playerView[o + 15] < 0.5) continue;
        const px = playerView[o], py = playerView[o+1], pz = playerView[o+2];
        const footY = py - 1.75;
        for (let e = 0; e < 3; e++) {
            _skiPool.emit(
                px + (Math.random()-0.5)*0.3,
                footY + Math.random()*0.08,
                pz + (Math.random()-0.5)*0.3,
                (Math.random()-0.5)*2.0,
                Math.random()*1.5 + 0.3,
                (Math.random()-0.5)*2.0
            );
        }
    }
}

function _emitTrailParticles() {
    if (!_deps) return;
    const pv = _deps.getProjectileView();
    if (!pv) return;
    const { view: projectileView, stride: projectileStride } = pv;
    const count = _deps.getProjectileCount ? _deps.getProjectileCount() : 0;
    for (let p = 0; p < count && p < _deps.MAX_PROJECTILES; p++) {
        const o = p * projectileStride;
        if (projectileView[o + 9] < 0.5) continue;
        const type = projectileView[o + 6] | 0;
        const rgb = _TRAIL_RGB[type] || _TRAIL_RGB[0];
        _trailPool.emit(
            projectileView[o] + (Math.random()-0.5)*0.05,
            projectileView[o+1] + (Math.random()-0.5)*0.05,
            projectileView[o+2] + (Math.random()-0.5)*0.05,
            0, 0, 0, // no velocity
            undefined, // default lifetime
            0.8 + Math.random() * 0.2,
            rgb[0], rgb[1], rgb[2]
        );
    }
}

function _updateExplosionFireballs(dt) {
    if (!_explPool) return;
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
}

/**
 * Trigger an explosion at a world position.
 */
export function triggerExplosion(px, py, pz, intensity) {
    if (!_explPool) return;
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
    slot.intensity = intensity || 1.0;
    slot.mesh.position.set(px, py, pz);
    slot.mesh.scale.setScalar(0.3);
    slot.mesh.visible = true;

    // Emit sparks
    if (_sparkPool) {
        const sparkCount = Math.round(SPARKS_PER_EXPLOSION * Math.min(1.5, slot.intensity));
        for (let s = 0; s < sparkCount; s++) {
            const speed = (3.0 + Math.random() * 8.0) * slot.intensity;
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.random() * Math.PI * 0.8;
            _sparkPool.emit(
                px + (Math.random() - 0.5) * 0.5,
                py + (Math.random() - 0.5) * 0.5,
                pz + (Math.random() - 0.5) * 0.5,
                Math.sin(phi) * Math.cos(theta) * speed,
                Math.cos(phi) * speed * 0.7 + 2.0,
                Math.sin(phi) * Math.sin(theta) * speed,
                0.4 + Math.random() * 0.35,
                0.8 + Math.random() * 0.2
            );
        }
    }
}

/**
 * Generic emit for external callers.
 * @param {'ski'|'trail'|'spark'|'explosion'} type
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {object} [params] - { vx, vy, vz, intensity, projType }
 */
export function emit(type, x, y, z, params) {
    params = params || {};
    switch (type) {
        case 'ski':
            if (_skiPool) _skiPool.emit(x, y, z, params.vx || 0, params.vy || 0, params.vz || 0);
            break;
        case 'trail': {
            const rgb = _TRAIL_RGB[params.projType || 0] || _TRAIL_RGB[0];
            if (_trailPool) _trailPool.emit(x, y, z, 0, 0, 0, undefined, undefined, rgb[0], rgb[1], rgb[2]);
            break;
        }
        case 'spark':
            if (_sparkPool) _sparkPool.emit(x, y, z, params.vx || 0, params.vy || 0, params.vz || 0);
            break;
        case 'explosion':
            triggerExplosion(x, y, z, params.intensity || 1.0);
            break;
    }
}

/**
 * Dispose all particle resources. Cleans up GPU memory.
 */
export function dispose() {
    if (_skiPool)   { _skiPool.dispose(); _skiPool = null; }
    if (_trailPool) { _trailPool.dispose(); _trailPool = null; }
    if (_sparkPool) { _sparkPool.dispose(); _sparkPool = null; }
    if (_wasmParticleSystem) {
        _wasmParticleSystem.geometry.dispose();
        _wasmParticleSystem.material.dispose();
        if (_wasmParticleSystem.parent) _wasmParticleSystem.parent.remove(_wasmParticleSystem);
        _wasmParticleSystem = null;
    }
    if (_explPool) {
        for (const ex of _explPool) {
            ex.mesh.geometry.dispose();
            ex.mesh.material.dispose();
            if (ex.mesh.parent) ex.mesh.parent.remove(ex.mesh);
        }
        _explPool = null;
    }
    if (_nfPoints) {
        _nfPoints.geometry.dispose();
        _nfPoints.material.dispose();
        if (_nfPoints.parent) _nfPoints.parent.remove(_nfPoints);
        _nfPoints = null;
    }
    if (_nfHeightTex) { _nfHeightTex.dispose(); _nfHeightTex = null; }
    _wasmParticleGeom = null;
    _wasmPositions = null;
    _wasmColors = null;
    _wasmSizes = null;
    _prevParticleAge = null;
    _disposeJetExhaust();
    console.log('[R32.272] All particle systems disposed');
}
