/**
 * @ai-contract
 * MODULE: renderer_postprocess.js
 * PURPOSE: Post-processing pipeline — bloom, vignette, film grain, color grading
 * IMPORTS: Three.js (EffectComposer, RenderPass, UnrealBloomPass, ShaderPass, OutputPass)
 * EXPORTS: { init, update, render, resize, dispose, rebuild, bloomPass, gradePass, composer }
 * EXPOSES: window.__tribesBloom, window.__tribesComposer (debug)
 * LIFECYCLE: init() → update()/render() per frame → resize() on window resize → dispose() on teardown
 * OWNER: Visual Cohesion (bloom, vignette, film grain)
 * EXTRACTED FROM: renderer.js R32.203 (was lines ~3321-3506)
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

let _composer = null;
let _bloomPass = null;
let _gradePass = null;
let _renderer = null;
let _scene = null;
let _camera = null;

// ============================================================
// Vignette + warm-shadow + desaturation + film grain shader
// ============================================================
function _makeVignetteAndGradeShader() {
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
// Cinematic LUT builder (32^3 packed into 1024x32 strip)
// ============================================================
function _buildCinematicLUT() {
    const SIZE = 32;
    const W = SIZE * SIZE;     // 1024
    const H = SIZE;            // 32
    const data = new Uint8Array(W * H * 4);
    for (let bIdx = 0; bIdx < SIZE; bIdx++) {
        for (let gIdx = 0; gIdx < SIZE; gIdx++) {
            for (let rIdx = 0; rIdx < SIZE; rIdx++) {
                let r = rIdx / (SIZE - 1);
                let g = gIdx / (SIZE - 1);
                let b = bIdx / (SIZE - 1);
                const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                const shadow = 1.0 - Math.min(1, luma * 2.5);
                b += 0.045 * shadow;
                r -= 0.012 * shadow;
                const highlight = Math.max(0, (luma - 0.6) / 0.4);
                r += 0.055 * highlight;
                g += 0.030 * highlight;
                b -= 0.020 * highlight;
                r = r * r * (3 - 2 * r);
                g = g * g * (3 - 2 * g);
                b = b * b * (3 - 2 * b);
                r = r * 0.92 + 0.04;
                g = g * 0.92 + 0.04;
                b = b * 0.92 + 0.04;
                const finalLuma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                const desat = 0.08;
                r = r * (1 - desat) + finalLuma * desat;
                g = g * (1 - desat) + finalLuma * desat;
                b = b * (1 - desat) + finalLuma * desat;
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

// ============================================================
// Public API
// ============================================================

/**
 * Initialize the post-processing pipeline.
 * @param {THREE.WebGLRenderer} rendererRef
 * @param {THREE.Scene} sceneRef
 * @param {THREE.Camera} cameraRef
 * @param {object} tier - quality tier from readQualityFromSettings()
 * @param {string} currentQuality - current quality name for logging
 */
export function init(rendererRef, sceneRef, cameraRef, tier, currentQuality) {
    _renderer = rendererRef;
    _scene = sceneRef;
    _camera = cameraRef;

    // R32.161: Dispose old composer before creating a new one.
    dispose();

    console.log('[R32.203] initPostProcessing: tier.postProcess=' + tier.postProcess + ' quality=' + currentQuality);

    // R32.54 DIAGNOSTIC: ?nopost → skip EffectComposer entirely, render direct
    const _dp = new URLSearchParams(window.location.search);
    if (_dp.has('nopost')) {
        console.log('[R32.54-DIAG] nopost: EffectComposer disabled, direct render');
        return;
    }
    if (!tier.postProcess) {
        console.log('[R32.203] initPostProcessing BAILED: tier.postProcess is falsy (' + tier.postProcess + ')');
        return;
    }

    if (!sceneRef)    throw new Error('[R29.2] initPostProcessing called before initScene()');
    if (!cameraRef)   throw new Error('[R29.2] initPostProcessing called before initStateViews() — camera is undefined');
    if (!rendererRef) throw new Error('[R29.2] initPostProcessing called before initRenderer() — renderer is undefined');

    _composer = new EffectComposer(rendererRef);
    _composer.setPixelRatio(tier.pixelRatio);
    const renderPass = new RenderPass(sceneRef, cameraRef);
    _composer.addPass(renderPass);

    _bloomPass = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        0.30, 0.45, 0.92
    );
    _bloomPass.enabled = true;
    _composer.addPass(_bloomPass);

    if (tier.postProcess === 'full') {
        _gradePass = new ShaderPass(_makeVignetteAndGradeShader());
        _composer.addPass(_gradePass);
    }
    _composer.addPass(new OutputPass());

    console.log('[R32.203] Post-processing initialized: composer=' + !!_composer +
        ' bloomPass=' + !!_bloomPass + ' bloomEnabled=' + _bloomPass.enabled +
        ' strength=' + _bloomPass.strength);

    window.__tribesBloom = _bloomPass;
    window.__tribesComposer = _composer;
}

/**
 * Per-frame update: night-adaptive bloom + film grain animation.
 * @param {number} dayMix - 1=noon, 0=midnight (from DayNight module)
 */
export function update(dayMix) {
    if (_bloomPass) {
        const nightBloom = dayMix < 0.15 ? 1.0 : (dayMix > 0.5 ? 0.0 : (0.5 - dayMix) / 0.35);
        _bloomPass.enabled = nightBloom > 0.01;
        _bloomPass.strength = 0.55 * nightBloom;
        _bloomPass.threshold = 0.92 - 0.15 * nightBloom;
    }

    if (_gradePass && _gradePass.material && _gradePass.material.uniforms && _gradePass.material.uniforms.time) {
        _gradePass.material.uniforms.time.value = (_gradePass.material.uniforms.time.value + 0.05) % 10000.0;
    }
}

/**
 * Render through the composer, or fall back to direct renderer.render().
 */
export function render() {
    if (_composer) {
        _composer.render();
    } else if (_renderer && _scene && _camera) {
        _renderer.render(_scene, _camera);
    }
}

/**
 * Handle window resize.
 */
export function resize(w, h) {
    if (_composer) _composer.setSize(w, h);
    if (_gradePass && _gradePass.material && _gradePass.material.uniforms && _gradePass.material.uniforms.resolution) {
        _gradePass.material.uniforms.resolution.value.set(w, h);
    }
}

/**
 * Dispose all post-processing resources. MANDATORY — prevents GPU leaks.
 * Safe to call multiple times.
 */
export function dispose() {
    if (_composer) {
        try {
            if (typeof _composer.dispose === 'function') {
                _composer.dispose();
            } else {
                if (_composer.renderTarget1) _composer.renderTarget1.dispose();
                if (_composer.renderTarget2) _composer.renderTarget2.dispose();
            }
        } catch (e) { console.warn('[R32.203] composer dispose error:', e); }
        _composer = null;
    }
    _bloomPass = null;
    _gradePass = null;
    window.__tribesBloom = null;
    window.__tribesComposer = null;
}

/**
 * Rebuild the pipeline for a quality change.
 * @param {object} tier - new quality tier
 * @param {string} currentQuality - quality name for logging
 */
export function rebuild(tier, currentQuality) {
    if (!_renderer || !_scene || !_camera) {
        console.warn('[R32.203] rebuild called before init — skipping');
        return;
    }
    init(_renderer, _scene, _camera, tier, currentQuality);
}

/** Read-only accessors for external systems that need bloom/grade state */
export function getComposer() { return _composer; }
export function getBloomPass() { return _bloomPass; }
export function getGradePass() { return _gradePass; }
export function isActive() { return !!_composer; }
