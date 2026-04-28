// renderer_sky_custom.js — R32.61
// Custom procedural skybox with stars, moon, and gradient sky.
// Replaces THREE.Sky for night scenes. Driven by DayNight cycle.
// Star shader adapted from red-reddington's Three.js Sky System
// (https://codepen.io/the-red-reddington/full/MYKRZNN)

import * as THREE from './vendor/three/r170/three.module.js';

// ============================================================
// Star field — twinkling points on a large sphere
// ============================================================
const StarsShader = {
    vertexShader: `
        attribute float aSize;
        attribute vec3 aColor;
        attribute float aPhase;
        attribute float aFreq;
        uniform float uTime;
        uniform float uOpacity;
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
            vColor = aColor;
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

            // Twinkle: each star has its own phase and frequency
            float twinkle = sin(uTime * aFreq + aPhase) * 0.3 + 0.7;
            gl_PointSize = aSize * twinkle;

            // Push to far depth so stars are always behind everything
            vec4 pos = projectionMatrix * mvPosition;
            pos.z = pos.w * 0.999999;
            gl_Position = pos;

            vAlpha = twinkle * uOpacity;
        }
    `,
    fragmentShader: `
        precision mediump float;
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
            vec2 center = gl_PointCoord - vec2(0.5);
            float dist = length(center) * 2.0;

            // Bright core + soft glow
            float core = (1.0 - smoothstep(0.0, 0.25, dist)) * 0.9;
            float glow = (1.0 - smoothstep(0.2, 0.6, dist)) * 0.15;
            float brightness = core + glow;

            vec3 col = mix(vec3(1.0), vColor, 0.7);
            gl_FragColor = vec4(col, brightness * vAlpha);
            if (gl_FragColor.a < 0.01) discard;
        }
    `
};

let _starPoints = null;
let _moonSprite = null;
let _starOpacityTarget = 0.0;
let _starOpacityCurrent = 0.0;

export function initCustomSky(scene) {
    _createStarField(scene);
    _createMoon(scene);
    console.log('[R32.61] Custom sky system initialized (stars + moon)');
}

function _createStarField(scene) {
    const N = 4000;
    const radius = 900; // large sphere around the scene

    const positions = new Float32Array(N * 3);
    const colors = new Float32Array(N * 3);
    const sizes = new Float32Array(N);
    const phases = new Float32Array(N);
    const freqs = new Float32Array(N);

    // Star color distribution: mostly white, some blue, some warm
    const starColors = [
        [1.0, 1.0, 1.0],       // white (common)
        [0.8, 0.85, 1.0],      // blue-white
        [0.7, 0.8, 1.0],       // blue
        [1.0, 0.95, 0.8],      // warm white
        [1.0, 0.85, 0.7],      // yellow
        [1.0, 0.7, 0.6],       // orange (rare)
    ];

    for (let i = 0; i < N; i++) {
        // Distribute on upper hemisphere (stars above horizon)
        // Use full sphere but weight toward upper half
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(1 - Math.random() * 1.3); // bias toward top
        const r = radius;

        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.cos(phi); // Y up
        positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);

        // Only keep stars above horizon (Y > -50)
        if (positions[i * 3 + 1] < -50) {
            positions[i * 3 + 1] = Math.abs(positions[i * 3 + 1]);
        }

        // Color: weighted random, mostly white
        const ci = Math.random() < 0.6 ? 0 : Math.floor(Math.random() * starColors.length);
        const sc = starColors[ci];
        colors[i * 3] = sc[0];
        colors[i * 3 + 1] = sc[1];
        colors[i * 3 + 2] = sc[2];

        // Size: most small, a few bright
        sizes[i] = Math.random() < 0.95 ? (1.0 + Math.random() * 2.0) : (3.0 + Math.random() * 3.0);

        phases[i] = Math.random() * Math.PI * 2;
        freqs[i] = 0.5 + Math.random() * 2.5; // twinkle speed
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geom.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geom.setAttribute('aFreq', new THREE.BufferAttribute(freqs, 1));

    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uTime: { value: 0.0 },
            uOpacity: { value: 0.0 },
        },
        vertexShader: StarsShader.vertexShader,
        fragmentShader: StarsShader.fragmentShader,
        transparent: true,
        depthWrite: false,
        depthTest: false, // always behind everything
        blending: THREE.AdditiveBlending,
    });

    _starPoints = new THREE.Points(geom, mat);
    _starPoints.frustumCulled = false;
    _starPoints.renderOrder = -100; // render before scene objects
    scene.add(_starPoints);
}

function _createMoon(scene) {
    // Procedural moon texture via canvas
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // Moon disc: soft white circle with subtle craters
    const gradient = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
    gradient.addColorStop(0, 'rgba(240, 240, 255, 1.0)');
    gradient.addColorStop(0.5, 'rgba(220, 220, 240, 0.95)');
    gradient.addColorStop(0.8, 'rgba(180, 180, 210, 0.6)');
    gradient.addColorStop(1.0, 'rgba(100, 100, 140, 0.0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    // Subtle crater spots
    const craters = [[35, 40, 8], [70, 55, 6], [55, 75, 10], [80, 35, 5], [45, 60, 7]];
    for (const [cx, cy, cr] of craters) {
        const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
        cg.addColorStop(0, 'rgba(160, 160, 180, 0.15)');
        cg.addColorStop(1, 'rgba(160, 160, 180, 0.0)');
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.arc(cx, cy, cr, 0, Math.PI * 2);
        ctx.fill();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;

    const mat = new THREE.SpriteMaterial({
        map: tex,
        color: 0xdde0ff,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.0,
    });

    _moonSprite = new THREE.Sprite(mat);
    _moonSprite.scale.set(60, 60, 1);
    _moonSprite.renderOrder = -99;
    scene.add(_moonSprite);
}

// Called every frame from the render loop.
// dayMix: 0 = midnight, 1 = noon (from DayNight cycle)
// sunPos: THREE.Vector3 current sun direction
export function updateCustomSky(t, dayMix, sunPos, cameraPos) {
    // Stars: visible at night, fade during dawn/dusk
    _starOpacityTarget = Math.max(0, 1.0 - dayMix * 2.5); // starts fading at dayMix=0.4
    // Smooth lerp so stars don't pop
    _starOpacityCurrent += (_starOpacityTarget - _starOpacityCurrent) * 0.02;

    if (_starPoints) {
        _starPoints.material.uniforms.uTime.value = t;
        _starPoints.material.uniforms.uOpacity.value = _starOpacityCurrent;
        // Center on camera so stars don't drift
        if (cameraPos) {
            _starPoints.position.set(cameraPos.x, cameraPos.y, cameraPos.z);
        }
        _starPoints.visible = _starOpacityCurrent > 0.01;
    }

    // Moon: opposite the sun, visible at night
    if (_moonSprite && sunPos) {
        // Moon position: opposite sun, on a large radius
        const moonDist = 800;
        _moonSprite.position.set(
            -sunPos.x * moonDist + (cameraPos ? cameraPos.x : 0),
            Math.max(50, -sunPos.y * moonDist) + (cameraPos ? cameraPos.y : 0),
            -sunPos.z * moonDist + (cameraPos ? cameraPos.z : 0)
        );
        // Opacity: visible at night
        const moonOpacity = Math.max(0, 1.0 - dayMix * 3.0);
        _moonSprite.material.opacity = moonOpacity * 0.85;
        _moonSprite.visible = moonOpacity > 0.01;
    }
}
