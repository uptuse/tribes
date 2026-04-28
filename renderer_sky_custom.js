// renderer_sky_custom.js — R32.63 REWRITE
// Custom procedural sky system: sky dome + stars + clouds
// Replaces THREE.Sky entirely. All driven by a single dayMix value (0=midnight, 1=noon).
//
// Architecture:
//   1. Sky dome — ShaderMaterial sphere with gradient, sun disc, moon disc
//   2. Stars — Points mesh with twinkling (from R32.61, refined)
//   3. Clouds — transparent sphere with simplex noise, thins at night
//
// Star shader concept adapted from red-reddington's Three.js Sky System.

import * as THREE from './vendor/three/r170/three.module.js';

// ============================================================
// Sky Dome — gradient + sun + moon in one shader
// ============================================================
const SkyDomeShader = {
    vertexShader: `
        varying vec3 vWorldDir;
        void main() {
            vec4 worldPos = modelMatrix * vec4(position, 1.0);
            vWorldDir = normalize(worldPos.xyz - cameraPosition);
            // Push to far plane
            vec4 pos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            gl_Position = pos.xyww;
        }
    `,
    fragmentShader: `
        precision highp float;
        varying vec3 vWorldDir;

        uniform float uDayMix;      // 0 = midnight, 1 = noon
        uniform vec3  uSunDir;      // normalized sun direction
        uniform float uTime;        // for subtle cloud animation

        // Sky gradient colors
        vec3 daySkyTop    = vec3(0.25, 0.55, 0.95);   // blue
        vec3 daySkyHoriz  = vec3(0.65, 0.80, 0.95);   // pale blue horizon
        vec3 dawnSkyTop   = vec3(0.30, 0.35, 0.60);   // muted purple-blue
        vec3 dawnSkyHoriz = vec3(0.90, 0.55, 0.30);   // warm orange horizon
        vec3 nightSkyTop  = vec3(0.01, 0.01, 0.04);   // near black
        vec3 nightSkyHoriz= vec3(0.03, 0.04, 0.10);   // very dark blue horizon

        // Simple 3-stop lerp: night → dawn/dusk → day
        vec3 skyLerp(vec3 night, vec3 dawn, vec3 day, float d) {
            if (d < 0.3) return mix(night, dawn, d / 0.3);
            return mix(dawn, day, (d - 0.3) / 0.7);
        }

        void main() {
            vec3 dir = normalize(vWorldDir);
            float upness = dir.y; // -1 to +1

            // Ground plane: below horizon, darken
            float horizonMask = smoothstep(-0.05, 0.1, upness);

            // Sky gradient
            float skyT = clamp(upness * 1.5, 0.0, 1.0);
            vec3 skyTop   = skyLerp(nightSkyTop,   dawnSkyTop,   daySkyTop,   uDayMix);
            vec3 skyHoriz = skyLerp(nightSkyHoriz,  dawnSkyHoriz, daySkyHoriz, uDayMix);
            vec3 sky = mix(skyHoriz, skyTop, skyT);

            // Below horizon: dark ground color
            vec3 groundColor = mix(vec3(0.01, 0.01, 0.02), vec3(0.15, 0.18, 0.15), uDayMix);
            sky = mix(groundColor, sky, horizonMask);

            // Sun disc — R32.63.3: small, natural sun. NOT a supernova.
            float sunDot = dot(dir, uSunDir);
            float sunDisc = smoothstep(0.9997, 0.99995, sunDot); // tiny bright core
            float sunGlow = pow(max(sunDot, 0.0), 2000.0) * 0.3; // very tight glow
            float sunHalo = pow(max(sunDot, 0.0), 128.0) * 0.08; // subtle warm haze
            vec3 sunColor = vec3(1.0, 0.95, 0.85);
            float sunAbove = smoothstep(-0.02, 0.05, uSunDir.y);
            sky += sunColor * (sunDisc * 2.0 + sunGlow + sunHalo) * sunAbove;

            // Moon disc — R32.63.2: textured with crater noise, not a flat circle
            vec3 moonDir = normalize(vec3(-uSunDir.x, max(0.15, -uSunDir.y), -uSunDir.z));
            float moonDot = dot(dir, moonDir);
            float moonMask = smoothstep(0.9985, 0.9992, moonDot); // moon disc area
            float moonGlow = pow(max(moonDot, 0.0), 200.0) * 0.06;
            // Crater noise — project onto moon face for texture
            vec3 moonLocal = dir - moonDir * moonDot;
            float cx = dot(moonLocal, vec3(1.0, 0.0, 0.0)) * 800.0;
            float cy = dot(moonLocal, vec3(0.0, 1.0, 0.0)) * 800.0;
            float crater1 = smoothstep(0.3, 0.0, length(vec2(cx - 2.0, cy + 1.5)));
            float crater2 = smoothstep(0.25, 0.0, length(vec2(cx + 1.0, cy - 2.0)));
            float crater3 = smoothstep(0.20, 0.0, length(vec2(cx + 2.5, cy + 0.5)));
            float crater4 = smoothstep(0.35, 0.0, length(vec2(cx - 0.5, cy + 3.0)));
            float crater5 = smoothstep(0.15, 0.0, length(vec2(cx + 1.8, cy + 2.2)));
            float craters = (crater1 + crater2 + crater3 + crater4 + crater5) * 0.12;
            // Moon surface: bright silvery with dark mare patches
            vec3 moonBase = vec3(0.85, 0.87, 0.92);
            vec3 moonDark = vec3(0.55, 0.56, 0.62);
            vec3 moonSurf = mix(moonBase, moonDark, craters);
            float moonVis = 1.0 - uDayMix; // visible at night
            float moonAbove = smoothstep(-0.02, 0.10, moonDir.y);
            sky += moonSurf * moonMask * 0.8 * moonVis * moonAbove;
            sky += vec3(0.7, 0.75, 0.9) * moonGlow * moonVis * moonAbove;

            // Horizon glow at sunset/sunrise
            float horizGlow = pow(max(1.0 - abs(upness), 0.0), 4.0);
            float sunNearHoriz = smoothstep(0.3, 0.0, abs(uSunDir.y));
            vec3 horizColor = vec3(1.0, 0.45, 0.15) * horizGlow * sunNearHoriz * 0.5;
            sky += horizColor;

            gl_FragColor = vec4(sky, 1.0);
        }
    `
};

// ============================================================
// Cloud layer — separate transparent dome with noise
// ============================================================
const CloudShader = {
    vertexShader: `
        varying vec3 vWorldDir;
        varying vec2 vUv;
        void main() {
            vUv = uv;
            vec4 worldPos = modelMatrix * vec4(position, 1.0);
            vWorldDir = normalize(worldPos.xyz - cameraPosition);
            vec4 pos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            gl_Position = pos.xyww;
        }
    `,
    fragmentShader: `
        precision highp float;
        varying vec3 vWorldDir;
        varying vec2 vUv;

        uniform float uTime;
        uniform float uDayMix;
        uniform vec3  uSunDir;

        // Simplex-ish noise
        vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec2 mod289v2(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }
        float snoise(vec2 v) {
            const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
            vec2 i = floor(v + dot(v, C.yy));
            vec2 x0 = v - i + dot(i, C.xx);
            vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
            vec4 x12 = x0.xyxy + C.xxzz;
            x12.xy -= i1;
            i = mod289v2(i);
            vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
            vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
            m = m*m; m = m*m;
            vec3 x = 2.0 * fract(p * C.www) - 1.0;
            vec3 h = abs(x) - 0.5;
            vec3 ox = floor(x + 0.5);
            vec3 a0 = x - ox;
            m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
            vec3 g;
            g.x = a0.x * x0.x + h.x * x0.y;
            g.yz = a0.yz * x12.xz + h.yz * x12.yw;
            return 130.0 * dot(m, g);
        }

        void main() {
            vec3 dir = normalize(vWorldDir);
            // Only draw clouds in upper hemisphere
            if (dir.y < 0.05) discard;

            // Project to a flat plane for cloud UVs
            vec2 cloudUv = dir.xz / (dir.y + 0.1) * 0.3;
            cloudUv += uTime * vec2(0.008, 0.003); // slow drift

            // Multi-octave noise
            float n = snoise(cloudUv * 3.0) * 0.5
                    + snoise(cloudUv * 6.0 + 42.0) * 0.3
                    + snoise(cloudUv * 12.0 + 84.0) * 0.2;

            // Thin, wispy clouds (high threshold = less coverage)
            float density = smoothstep(0.15, 0.55, n * 0.5 + 0.5);

            // Fade near horizon and at edges
            float altFade = smoothstep(0.05, 0.25, dir.y);
            density *= altFade * 0.45; // max 45% opacity — never solid

            // At night: thin clouds further so stars show
            density *= mix(0.3, 1.0, uDayMix);

            // Cloud color: white during day, lit by sun at sunset, dark blue at night
            vec3 dayCloud = vec3(0.95, 0.95, 0.97);
            vec3 sunsetCloud = vec3(1.0, 0.65, 0.35);
            vec3 nightCloud = vec3(0.12, 0.14, 0.22);
            float sunsetness = smoothstep(0.3, 0.0, abs(uSunDir.y));
            vec3 cloudCol = mix(nightCloud, mix(dayCloud, sunsetCloud, sunsetness), uDayMix);

            if (density < 0.01) discard;
            gl_FragColor = vec4(cloudCol, density);
        }
    `
};

// ============================================================
// Stars — twinkling point sprites
// ============================================================
const StarsShader = {
    vertexShader: `
        attribute float aSize;
        attribute vec3 aColor;
        attribute float aPhase;
        attribute float aFreq;
        uniform float uTime;
        uniform float uOpacity;
        uniform vec3 uSunDir;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
            vColor = aColor;
            vec3 worldDir = normalize(position);
            // Suppress stars near sun AND moon to prevent bleed
            float sunDot = dot(worldDir, uSunDir);
            float sunSuppress = smoothstep(0.80, 0.95, sunDot); // wider suppression zone
            vec3 moonDir2 = normalize(vec3(-uSunDir.x, max(0.15, -uSunDir.y), -uSunDir.z));
            float moonSuppress = smoothstep(0.90, 0.97, dot(worldDir, moonDir2));
            float suppress = max(sunSuppress, moonSuppress);

            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            float twinkle = sin(uTime * aFreq + aPhase) * 0.3 + 0.7;
            gl_PointSize = aSize * twinkle;
            vec4 pos = projectionMatrix * mvPosition;
            pos.z = pos.w * 0.999999;
            gl_Position = pos;
            vAlpha = twinkle * uOpacity * (1.0 - suppress);
        }
    `,
    fragmentShader: `
        precision mediump float;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
            vec2 center = gl_PointCoord - vec2(0.5);
            float dist = length(center) * 2.0;
            float core = (1.0 - smoothstep(0.0, 0.25, dist)) * 0.9;
            float glow = (1.0 - smoothstep(0.2, 0.6, dist)) * 0.15;
            float brightness = core + glow;
            vec3 col = mix(vec3(1.0), vColor, 0.7);
            gl_FragColor = vec4(col, brightness * vAlpha);
            if (gl_FragColor.a < 0.01) discard;
        }
    `
};

// ============================================================
// Module state
// ============================================================
let _skyDome = null;
let _cloudDome = null;
let _starPoints = null;
let _starOpacity = 0.0;

// ============================================================
// Public API
// ============================================================
export function initCustomSky(scene) {
    _createSkyDome(scene);
    _createCloudDome(scene);
    _createStarField(scene);
    console.log('[R32.63] Custom sky system initialized (dome + clouds + stars)');
}

export function updateCustomSky(t, dayMix, sunDir, cameraPos) {
    if (_skyDome) {
        const u = _skyDome.material.uniforms;
        u.uDayMix.value = dayMix;
        u.uSunDir.value.copy(sunDir);
        u.uTime.value = t;
        if (cameraPos) _skyDome.position.copy(cameraPos);
    }

    if (_cloudDome) {
        const u = _cloudDome.material.uniforms;
        u.uDayMix.value = dayMix;
        u.uSunDir.value.copy(sunDir);
        u.uTime.value = t;
        if (cameraPos) _cloudDome.position.copy(cameraPos);
    }

    // Stars: completely hidden during day, fade in only at deep dusk
    const starTarget = dayMix < 0.15 ? (1.0 - dayMix / 0.15) : 0.0;
    _starOpacity += (starTarget - _starOpacity) * 0.05;
    if (_starPoints) {
        _starPoints.material.uniforms.uTime.value = t;
        _starPoints.material.uniforms.uOpacity.value = _starOpacity;
        _starPoints.material.uniforms.uSunDir.value.copy(sunDir);
        if (cameraPos) _starPoints.position.copy(cameraPos);
        _starPoints.visible = _starOpacity > 0.01;
    }
}

// Remove old sky systems
export function removeOldSky(scene, oldSky) {
    if (oldSky) {
        scene.remove(oldSky);
        if (oldSky.material) oldSky.material.dispose();
        if (oldSky.geometry) oldSky.geometry.dispose();
    }
}

// ============================================================
// Internals
// ============================================================
function _createSkyDome(scene) {
    const geom = new THREE.SphereGeometry(950, 32, 32);
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uDayMix: { value: 1.0 },
            uSunDir: { value: new THREE.Vector3(0, 1, 0) },
            uTime:   { value: 0.0 },
        },
        vertexShader: SkyDomeShader.vertexShader,
        fragmentShader: SkyDomeShader.fragmentShader,
        side: THREE.BackSide,
        depthWrite: false,
    });
    _skyDome = new THREE.Mesh(geom, mat);
    _skyDome.renderOrder = -1000;
    _skyDome.frustumCulled = false;
    scene.add(_skyDome);
}

function _createCloudDome(scene) {
    const geom = new THREE.SphereGeometry(900, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.5); // upper hemisphere only
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uDayMix: { value: 1.0 },
            uSunDir: { value: new THREE.Vector3(0, 1, 0) },
            uTime:   { value: 0.0 },
        },
        vertexShader: CloudShader.vertexShader,
        fragmentShader: CloudShader.fragmentShader,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
    });
    _cloudDome = new THREE.Mesh(geom, mat);
    _cloudDome.renderOrder = -999;
    _cloudDome.frustumCulled = false;
    scene.add(_cloudDome);
}

function _createStarField(scene) {
    const N = 4000;
    const radius = 880;
    const positions = new Float32Array(N * 3);
    const colors = new Float32Array(N * 3);
    const sizes = new Float32Array(N);
    const phases = new Float32Array(N);
    const freqs = new Float32Array(N);

    const starColors = [
        [1.0, 1.0, 1.0], [0.8, 0.85, 1.0], [0.7, 0.8, 1.0],
        [1.0, 0.95, 0.8], [1.0, 0.85, 0.7], [1.0, 0.7, 0.6],
    ];

    for (let i = 0; i < N; i++) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(1 - Math.random() * 1.3);
        positions[i * 3]     = radius * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = Math.abs(radius * Math.cos(phi)); // upper hemisphere
        positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);

        const ci = Math.random() < 0.6 ? 0 : Math.floor(Math.random() * starColors.length);
        const sc = starColors[ci];
        colors[i * 3] = sc[0]; colors[i * 3 + 1] = sc[1]; colors[i * 3 + 2] = sc[2];
        sizes[i] = Math.random() < 0.95 ? (1.0 + Math.random() * 2.0) : (3.0 + Math.random() * 3.0);
        phases[i] = Math.random() * Math.PI * 2;
        freqs[i] = 0.5 + Math.random() * 2.5;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geom.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geom.setAttribute('aFreq', new THREE.BufferAttribute(freqs, 1));

    const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0.0 }, uOpacity: { value: 0.0 }, uSunDir: { value: new THREE.Vector3(0, 1, 0) } },
        vertexShader: StarsShader.vertexShader,
        fragmentShader: StarsShader.fragmentShader,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
    });

    _starPoints = new THREE.Points(geom, mat);
    _starPoints.frustumCulled = false;
    _starPoints.renderOrder = -998;
    scene.add(_starPoints);
}
