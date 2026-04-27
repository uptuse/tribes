// renderer_living_color.js — R32.27
// Mood (D): "Cold World, Living Color".
//
// User-stated direction: a drab grey world; jets, players, weapons, projectiles,
// flags, base discs — anything alive or built by people — keeps its saturated
// color. Color is the visual signal of life and motion.
//
// This module runs once at end of renderer.js start(), AFTER toonify has done
// its material-conversion pass. It walks the scene and desaturates any
// material whose owning Object3D is not tagged as "alive". Tagging happens via
// userData._livingColorAlive = true on the root Object3D of the entity (or any
// ancestor — the walker checks ancestors).
//
// Escape hatch: ?livingcolor=off in the URL bypasses the desaturation pass.
//
// Public API:
//   window.LivingColor.init(THREE, scene)        — run once
//   window.LivingColor.tagAlive(obj)             — manually mark an object as alive
//   window.LivingColor.reapply()                 — re-walk after dynamic spawns
//   window.LivingColor.enabled                   — false if disabled via URL
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    const PARAMS = new URLSearchParams(window.location.search);
    const ENABLED = PARAMS.get('livingcolor') !== 'off';

    function _log() { if (window.DEBUG_LOGS) console.log.apply(console, arguments); }

    // -------------------------------------------------------------------
    // Tunables. Pulled out so a future settings pass can expose them.
    // -------------------------------------------------------------------
    // World saturation multiplier. 0 = fully grey, 1 = unchanged.
    // 0.12 reads as "drab industrial / abandoned" without going full B&W
    // (which would lose terrain readability — grass needs to be detectably
    // grass, not concrete).
    const WORLD_SATURATION = 0.12;
    // World hue push toward cold blue-grey. 0 = no shift, 1 = fully replace.
    // 0.15 just biases the residual color toward sky-haze blue.
    const WORLD_COOL_PUSH = 0.18;
    const COOL_TARGET = { r: 0xA8 / 255, g: 0xB0 / 255, b: 0xBA / 255 }; // matches R32.30-elect cold fog

    // -------------------------------------------------------------------
    // Living-entity detection.
    //
    // An object is "alive" if it OR any of its ancestors has
    // userData._livingColorAlive === true. The renderer.js side is
    // responsible for setting that tag at construction time; this module
    // also has a small allowlist of group names / userData kinds that get
    // auto-tagged (defense in depth — if renderer.js tagging is missed for
    // any group, the allowlist still catches it).
    // -------------------------------------------------------------------
    const ALIVE_USERDATA_KINDS = new Set([
        'repairpack',  // pickup, reads team color
        'flagstand',   // disc reads team color, base reads flag state
        'vehiclepad',  // emissive disc reads team color
    ]);

    function _isAliveAncestor(obj) {
        let n = obj;
        while (n) {
            if (n.userData && n.userData._livingColorAlive === true) return true;
            if (n.userData && n.userData.kind && ALIVE_USERDATA_KINDS.has(n.userData.kind)) return true;
            n = n.parent;
        }
        return false;
    }

    // -------------------------------------------------------------------
    // Material conversion. Operates in-place: we mutate material.color,
    // not the geometry. Stores the original color on userData._lcOriginal
    // so future re-applies don't compound the desaturation.
    //
    // Also skips:
    //   - MeshBasicMaterial used by emissive / sky / muzzle / hit-spark
    //     elements (they're already pure-color signals; treat as "alive"
    //     even if not parented to a tagged group).
    //   - Materials whose color is already near grey (saturation < 0.05).
    //   - LineBasicMaterial / SpriteMaterial / ShaderMaterial — desat
    //     would either be a no-op or break the shader (rain streaks,
    //     particles, sprites are intentionally bright).
    // -------------------------------------------------------------------
    function _desatColor(THREE, color) {
        // RGB -> HSL via THREE.Color helpers (saves us a manual conversion).
        const hsl = { h: 0, s: 0, l: 0 };
        color.getHSL(hsl);
        // Pure-grey already? skip.
        if (hsl.s < 0.05) return false;
        // Cut saturation to WORLD_SATURATION.
        hsl.s *= WORLD_SATURATION;
        color.setHSL(hsl.h, hsl.s, hsl.l);
        // Cold push toward sky-haze grey.
        color.r = color.r * (1 - WORLD_COOL_PUSH) + COOL_TARGET.r * WORLD_COOL_PUSH;
        color.g = color.g * (1 - WORLD_COOL_PUSH) + COOL_TARGET.g * WORLD_COOL_PUSH;
        color.b = color.b * (1 - WORLD_COOL_PUSH) + COOL_TARGET.b * WORLD_COOL_PUSH;
        return true;
    }

    function _processMaterial(THREE, mat) {
        if (!mat) return false;
        if (mat.userData && mat.userData._livingColorProcessed) return false;
        // Skip basic / sprite / shader materials — those carry intentional
        // signals (muzzle flash, rain, sky, particles, sprite icons).
        if (mat.isMeshBasicMaterial) return false;
        if (mat.isSpriteMaterial) return false;
        if (mat.isShaderMaterial) return false;
        if (mat.isLineBasicMaterial) return false;
        if (mat.isPointsMaterial) return false;
        // Only touch materials with a color slot.
        if (!mat.color) return false;
        // Save original for safe re-apply.
        if (!mat.userData) mat.userData = {};
        mat.userData._lcOriginal = mat.color.getHex();
        const changed = _desatColor(THREE, mat.color);
        // Also flatten any emissive on world materials. Emissive on world =
        // light source, we want emissive to stay alive-only. World should
        // not glow.
        if (mat.emissive && mat.emissiveIntensity > 0) {
            mat.userData._lcEmissiveOriginal = mat.emissive.getHex();
            mat.userData._lcEmissiveIntensityOriginal = mat.emissiveIntensity;
            mat.emissive = new THREE.Color(0x000000);
            mat.emissiveIntensity = 0;
        }
        mat.userData._livingColorProcessed = true;
        mat.needsUpdate = true;
        return changed;
    }

    // -------------------------------------------------------------------
    // Scene walker. Skip the sky dome (THREE.Sky uses a custom shader, not
    // a colorable material). Skip the grass mesh — grass already rides a
    // custom onBeforeCompile shader and forcing color writes can break wind
    // sway uniforms; grass desat will be handled separately if needed.
    // -------------------------------------------------------------------
    const SKIP_NAMES = new Set([
        'RaindanceInteriorShapes',  // not a name actually used as skip — interiors are world; placeholder
    ]);

    function _walk(THREE, scene) {
        let touched = 0;
        let aliveSkipped = 0;
        let gradeSkipped = 0;
        const seenMats = new Set();

        scene.traverse((obj) => {
            // Sky uses ShaderMaterial; _processMaterial will reject it.
            // Grass / rain / particles use Shader / Line / Points; rejected.
            if (!obj.isMesh && !obj.isSkinnedMesh && !obj.isInstancedMesh) return;

            if (_isAliveAncestor(obj)) {
                aliveSkipped++;
                return;
            }
            const m = obj.material;
            if (Array.isArray(m)) {
                for (const sub of m) {
                    if (!sub || seenMats.has(sub)) continue;
                    seenMats.add(sub);
                    if (_processMaterial(THREE, sub)) touched++;
                    else gradeSkipped++;
                }
            } else if (m) {
                if (seenMats.has(m)) return;
                seenMats.add(m);
                if (_processMaterial(THREE, m)) touched++;
                else gradeSkipped++;
            }
        });
        return { touched, aliveSkipped, gradeSkipped };
    }

    // -------------------------------------------------------------------
    // Public API.
    // -------------------------------------------------------------------
    const STATE = {
        enabled: ENABLED,
        scene: null,
        THREE: null,
    };

    function init(THREE, scene) {
        if (!ENABLED) {
            _log('[LivingColor] disabled via ?livingcolor=off');
            return { touched: 0, aliveSkipped: 0, gradeSkipped: 0, disabled: true };
        }
        STATE.THREE = THREE;
        STATE.scene = scene;
        try {
            const r = _walk(THREE, scene);
            _log('[LivingColor] init:', r);
            return r;
        } catch (e) {
            console.error('[LivingColor] init failed, world will not be desaturated:', e);
            return { touched: 0, aliveSkipped: 0, gradeSkipped: 0, error: String(e) };
        }
    }

    function tagAlive(obj) {
        if (!obj) return;
        if (!obj.userData) obj.userData = {};
        obj.userData._livingColorAlive = true;
    }

    function reapply() {
        if (!ENABLED || !STATE.scene || !STATE.THREE) return null;
        try {
            const r = _walk(STATE.THREE, STATE.scene);
            _log('[LivingColor] reapply:', r);
            return r;
        } catch (e) {
            console.error('[LivingColor] reapply failed:', e);
            return { error: String(e) };
        }
    }

    window.LivingColor = {
        enabled: ENABLED,
        init: init,
        tagAlive: tagAlive,
        reapply: reapply,
    };

    _log('[LivingColor] module loaded.', ENABLED ? '(enabled — mood D: cold world, living color)' : '(disabled via ?livingcolor=off)');
})();
