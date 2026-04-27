// renderer_toonify.js — R32.20
// Visual Cohesion #2.1A: commit to toon shader paradigm across the whole scene.
//
// Strategy: don't rewrite 50+ material creation sites. Instead, traverse the
// scene once after init and convert every MeshStandardMaterial in place to a
// MeshToonMaterial sharing a 4-band gradient ramp. Re-run on demand when new
// objects spawn.
//
// Escape hatch: ?style=pbr in the URL bypasses conversion entirely.
//
// Public API:
//   window.Toonify.toonifyScene(scene)  — convert everything once
//   window.Toonify.convertMaterial(mat) — convert a single material
//   window.Toonify.gradientMap          — the shared 4-band texture
//   window.Toonify.enabled              — false if ?style=pbr was passed
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    const PARAMS = new URLSearchParams(window.location.search);
    const ENABLED = PARAMS.get('style') !== 'pbr';

    function _log() { if (window.DEBUG_LOGS) console.log.apply(console, arguments); }

    // --- 4-band gradient ramp ---------------------------------------------
    // A 1×N data texture mapped to NdotL. 4 bands gives a clear, readable
    // toon look without the harshness of 2 bands or the muddiness of 8+.
    function _buildGradientMap(THREE) {
        // 4 luminance steps: shadow / midtone / light / highlight.
        // Values picked for a slightly flattened gamma so it reads "stylized"
        // not "broken".
        const data = new Uint8Array([60, 130, 200, 250]);
        const tex = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        return tex;
    }

    // --- Material conversion ---------------------------------------------
    // Copy the pieces of a MeshStandardMaterial that have a meaningful
    // counterpart on MeshToonMaterial. Toon materials don't support metalness
    // / roughness / env maps — those are PBR-only — but the COLOR, MAP,
    // EMISSIVE, EMISSIVE_MAP, NORMAL_MAP, ALPHA_MAP, TRANSPARENT, OPACITY,
    // SIDE, etc. all transfer.
    function _convertMaterial(THREE, mat, gradientMap) {
        // Skip non-target materials.
        if (!mat || mat.isMeshToonMaterial) return mat;
        if (!mat.isMeshStandardMaterial) return mat;

        // Build the toon equivalent.
        const toon = new THREE.MeshToonMaterial({
            color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
            map: mat.map || null,
            gradientMap: gradientMap,
            emissive: mat.emissive ? mat.emissive.clone() : new THREE.Color(0x000000),
            emissiveIntensity: (typeof mat.emissiveIntensity === 'number') ? mat.emissiveIntensity : 1.0,
            emissiveMap: mat.emissiveMap || null,
            normalMap: mat.normalMap || null,
            alphaMap: mat.alphaMap || null,
            transparent: !!mat.transparent,
            opacity: (typeof mat.opacity === 'number') ? mat.opacity : 1.0,
            side: (typeof mat.side === 'number') ? mat.side : THREE.FrontSide,
            depthTest: (typeof mat.depthTest === 'boolean') ? mat.depthTest : true,
            depthWrite: (typeof mat.depthWrite === 'boolean') ? mat.depthWrite : true,
            alphaTest: (typeof mat.alphaTest === 'number') ? mat.alphaTest : 0.0,
            visible: (typeof mat.visible === 'boolean') ? mat.visible : true,
        });
        // Tag for future detection / re-conversion safety.
        toon.userData._toonified = true;
        toon.userData._originalType = 'MeshStandardMaterial';
        return toon;
    }

    // --- Scene traversal --------------------------------------------------
    // Walks the scene graph; replaces material on any Mesh whose material
    // is MeshStandardMaterial. Handles arrays-of-materials (multi-material
    // meshes) too.
    function _toonifyScene(THREE, scene, gradientMap) {
        let count = 0;
        let skipped = 0;
        const seen = new WeakMap();

        scene.traverse(function (obj) {
            if (!obj.isMesh && !obj.isSkinnedMesh) return;
            const mat = obj.material;
            if (!mat) return;

            if (Array.isArray(mat)) {
                for (let i = 0; i < mat.length; i++) {
                    const m = mat[i];
                    if (!m || !m.isMeshStandardMaterial) { skipped++; continue; }
                    if (seen.has(m)) {
                        mat[i] = seen.get(m);
                        count++;
                        continue;
                    }
                    const conv = _convertMaterial(THREE, m, gradientMap);
                    seen.set(m, conv);
                    mat[i] = conv;
                    count++;
                }
            } else {
                if (!mat.isMeshStandardMaterial) { skipped++; return; }
                if (seen.has(mat)) {
                    obj.material = seen.get(mat);
                    count++;
                    return;
                }
                const conv = _convertMaterial(THREE, mat, gradientMap);
                seen.set(mat, conv);
                obj.material = conv;
                count++;
            }
        });

        return { converted: count, skipped: skipped };
    }

    // --- Public bootstrap -------------------------------------------------
    const STATE = {
        enabled: ENABLED,
        gradientMap: null,
        THREE: null,
        scene: null,
    };

    function init(THREE, scene) {
        if (!ENABLED) {
            _log('[Toonify] disabled via ?style=pbr — leaving materials as PBR.');
            return { converted: 0, skipped: 0, disabled: true };
        }
        STATE.THREE = THREE;
        STATE.scene = scene;
        STATE.gradientMap = _buildGradientMap(THREE);
        const result = _toonifyScene(THREE, scene, STATE.gradientMap);
        _log('[Toonify] init: converted', result.converted, 'materials,', result.skipped, 'skipped.');
        return result;
    }

    function reapply() {
        if (!ENABLED || !STATE.scene || !STATE.THREE) return null;
        const result = _toonifyScene(STATE.THREE, STATE.scene, STATE.gradientMap);
        _log('[Toonify] reapply: converted', result.converted, 'new materials.');
        return result;
    }

    function convertMaterial(mat) {
        if (!ENABLED || !STATE.THREE || !STATE.gradientMap) return mat;
        return _convertMaterial(STATE.THREE, mat, STATE.gradientMap);
    }

    window.Toonify = {
        enabled: ENABLED,
        init: init,
        reapply: reapply,
        convertMaterial: convertMaterial,
        get gradientMap() { return STATE.gradientMap; },
    };

    _log('[Toonify] module loaded.', ENABLED ? '(enabled)' : '(disabled via ?style=pbr)');
})();
