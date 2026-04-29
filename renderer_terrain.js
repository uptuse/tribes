// @ai-contract renderer_terrain.js
// PURPOSE: Terrain mesh generation — heightmap upscale, splat weights,
//          faceted geometry, texture array shader, carve-under-buildings
// SERVES: Scale (terrain defines the world), Aliveness (living-terrain breath)
// DEPENDS_ON: three (global), window.Module (Emscripten WASM)
// EXPOSES: init(deps), sampleHeight(x,z), carveUnderBuildings(shapesGroup),
//   getMesh(), getHeightmap(), getSplatData(), tick(t), dispose()
//   window._sampleTerrainH (legacy bridge for renderer_characters.js)
//   window.__tribesSetTerrainPBR (live PBR toggle)
// LIFECYCLE: init() once at start → tick(t) per frame → dispose() on teardown
// NOTES: Extracted from renderer.js R32.232. ~580 lines of init + carve.
//   Terrain shader has 6 onBeforeCompile string-replace hooks (vertex + fragment).
//   The heightmap is bicubic-upscaled 2× from WASM (257→513).

import * as THREE from 'three';

// ---- State ----
let _htSize = 0, _htScale = 1, _htData = null;
let _splatData = null;
let _terrainMesh = null;

// ---- Public height sampler (bilinear on upscaled grid) ----
export function sampleHeight(worldX, worldZ) {
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
window._sampleTerrainH = sampleHeight; // R32.120: expose for renderer_characters.js

// ---- Accessors ----
export function getMesh() { return _terrainMesh; }
export function getHeightmap() { return { data: _htData, size: _htSize, scale: _htScale }; }
export function getSplatData() { return _splatData; }

// ---- Per-frame tick (terrain shader uTime) ----
export function tick(t) {
    if (_terrainMesh && _terrainMesh.material && _terrainMesh.material.userData && _terrainMesh.material.userData.shader) {
        const u = _terrainMesh.material.userData.shader.uniforms;
        if (u && u.uTime) u.uTime.value = t;
    }
}

export async function init({ renderer, scene, Module }) {
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

    _terrainMesh = new THREE.Mesh(finalGeom, mat);
    _terrainMesh.receiveShadow = true;
    scene.add(_terrainMesh);
    // R32.37.1-manus: live PBR toggle hook — index.html settings checkboxes
    // call this on change to flip the uniform without recompile.
    window.__tribesSetTerrainPBR = function(key, on) {
        if (!_terrainMesh || !_terrainMesh.material || !_terrainMesh.material.userData) return;
        const sh = _terrainMesh.material.userData.shader;
        if (!sh || !sh.uniforms) return;
        const map = { roughness: 'uUseRoughness', ao: 'uUseAO', pom: 'uUsePOM' };
        const uname = map[key];
        if (!uname || !sh.uniforms[uname]) return;
        sh.uniforms[uname].value = on ? 1.0 : 0.0;
        _terrainMesh.material.needsUpdate = false; // uniform-only change, no recompile
    };
    console.log('[R32.42] Terrain: 3 array textures (color+normal+AO), roughness enabled, POM disabled');
}


// R32.141: Carve terrain under BASE buildings only (not all interior shapes)
// Only carve shapes that are actually embedded in the terrain (hobbit-holed).
// Skip rocks, cubes, floating pads, bridges, observation towers, and small objects.
export function carveUnderBuildings(interiorShapesGroup) {
    if (!_terrainMesh || !interiorShapesGroup) { console.warn('[R32.142] Carve: no _terrainMesh or interiorShapesGroup'); return; }

    const geo = _terrainMesh.geometry;
    const pos = geo.attributes.position;
    const size = _htSize;

    // Only carve for shapes that are actual base buildings embedded in hillsides
    const carvePatterns = ['bunker', 'esmall'];
    const boxes = [];
    console.log('[R32.143] Carve: checking', interiorShapesGroup.children.length, 'interior shapes');
    const allNames = [];
    interiorShapesGroup.children.forEach(outer => {
        if (!outer.userData) return;
        const fn = (outer.userData.fileName || '').toLowerCase();
        allNames.push(fn);
        // Only carve for base buildings
        const shouldCarve = carvePatterns.some(p => fn.startsWith(p));
        if (!shouldCarve) return;
        const box = new THREE.Box3().setFromObject(outer);
        if (box.isEmpty()) return;
        // Extra check: only carve if shape is near/below terrain level
        const terrainAtShape = sampleHeight(
            (box.min.x + box.max.x) / 2,
            (box.min.z + box.max.z) / 2
        );
        if (box.min.y > terrainAtShape + 5.0) return; // floating above terrain, skip
        boxes.push(box);
    });
    if (!boxes.length) return;

    let carved = 0;
    for (let vi = 0; vi < pos.count; vi++) {
        const wx = pos.getX(vi);
        const wy = pos.getY(vi);
        const wz = pos.getZ(vi);

        for (const box of boxes) {
            const margin = 2.0;
            if (wx >= box.min.x - margin && wx <= box.max.x + margin &&
                wz >= box.min.z - margin && wz <= box.max.z + margin) {
                const targetY = box.min.y - 1.5;
                if (wy > targetY) {
                    pos.setY(vi, targetY);
                    carved++;
                    break;
                }
            }
        }
    }

    if (carved > 0) {
        pos.needsUpdate = true;
        geo.computeVertexNormals();
        for (let vi = 0; vi < pos.count; vi++) {
            const j = Math.floor(vi / size);
            const i = vi % size;
            if (j < size && i < size) {
                _htData[j * size + i] = pos.getY(vi);
            }
        }
        console.warn(`[R32.143] Terrain carved: ${carved} vertices under ${boxes.length} base buildings`);
    } else {
        console.warn('[R32.143] Terrain carve: 0 vertices carved. boxes=' + boxes.length + ' allNames=' + JSON.stringify(allNames.slice(0,10)));
    }
}


// ---- Cleanup ----
export function dispose() {
    if (_terrainMesh) {
        if (_terrainMesh.geometry) _terrainMesh.geometry.dispose();
        if (_terrainMesh.material) {
            if (_terrainMesh.material.normalMap) _terrainMesh.material.normalMap.dispose();
            const sh = _terrainMesh.material.userData && _terrainMesh.material.userData.shader;
            if (sh && sh.uniforms) {
                if (sh.uniforms.uTerrainColor && sh.uniforms.uTerrainColor.value) sh.uniforms.uTerrainColor.value.dispose();
                if (sh.uniforms.uTerrainNormal && sh.uniforms.uTerrainNormal.value) sh.uniforms.uTerrainNormal.value.dispose();
                if (sh.uniforms.uTerrainAO && sh.uniforms.uTerrainAO.value) sh.uniforms.uTerrainAO.value.dispose();
            }
            _terrainMesh.material.dispose();
        }
        if (_terrainMesh.parent) _terrainMesh.parent.remove(_terrainMesh);
        _terrainMesh = null;
    }
    _htData = null;
    _htSize = 0;
    _htScale = 1;
    _splatData = null;
}
