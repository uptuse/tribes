// @ai-contract
// PURPOSE: Combat visual feedback — muzzle flash (additive sprite on weapon barrel),
//   projectile tracers (pooled glowing lines), crosshair hit flash (CSS animation).
//   Three systems that communicate "you shot / you hit" to the player
// SERVES: Adaptation (tactical feedback — tracers reveal positions, hits confirm damage)
// DEPENDS_ON: three (passed via init arg), window._weaponMuzzleAnchor (THREE.Object3D,
//   renderer.js — muzzle flash placement), window._tribesAimPoint3P (Object {x,y,z},
//   renderer.js — tracer endpoint)
// EXPOSES: window.CombatFX { init(scene, camera, weaponHand, THREE), fire(),
//   update(dt), flashHit(strong) }
// LIFECYCLE: init() once after scene/camera/weaponHand ready → fire() per shot →
//   update(dt) per frame to drive fade animations → flashHit() on damage confirm
// PATTERN: IIFE → window.CombatFX facade (legacy pattern)
// COORDINATE_SPACE: world (meters), Y-up for tracers; screen-space for hit flash
// BEFORE_MODIFY: read docs/lessons-learned.md. Muzzle flash texture is procedural
//   (256×256 canvas) — no external assets. Tracer pool is pre-allocated (4 lines)
// NEVER: allocate per-shot (use the pre-allocated pool)
// ALWAYS: use additive blending + depthWrite:false for FX meshes
// @end-ai-contract
//
/* ------------------------------------------------------------------
 * renderer_combat_fx.js  —  R32.13 (manus)
 *
 * Adds three combat-feel improvements that pair with the new audio:
 *
 *   1. MUZZLE FLASH — an additively-blended sprite quad anchored to the
 *      first-person weapon's barrel tip. Fires for ~70ms each shot with a
 *      randomized rotation so it never looks identical twice. Texture is
 *      generated procedurally at boot via a 256×256 canvas (no asset file
 *      needed, no external dep).
 *
 *   2. PROJECTILE TRACER — a thin glowing line drawn from the gun world-
 *      position to the aim-point world-position the moment the trigger
 *      fires, fading out over ~140ms. A small pool of 4 line objects is
 *      pre-allocated so rapid fire never allocates per-shot. Uses
 *      additive blending and a custom shader so the line glows without
 *      the cost of a thick MeshLine setup.
 *
 *   3. CROSSHAIR HIT FLASH — extends the existing #hit-tick element with
 *      animated 4-corner chevrons and a brass-color glow keyframe so a
 *      successful hit reads instantly instead of being a small "+".
 *
 * Public API:
 *   CombatFX.init(scene, camera, weaponHand, THREE)
 *     Call once after THREE/scene/camera/weaponHand are ready.
 *
 *   CombatFX.fire()
 *     Trigger muzzle flash + tracer for one shot. Caller is responsible
 *     for rate-limiting; CombatFX itself does not gate.
 *
 *   CombatFX.update(dt)
 *     Call every frame to drive flash/tracer fades.
 *
 *   CombatFX.flashHit(strong)
 *     Animate the crosshair hit indicator. `strong=true` for kill shots.
 *
 * Why a separate module?
 *   Combat FX touches HUD CSS, FPS-arm bones, scene graph, and per-shot
 *   timing. Keeping it isolated lets us iterate on game-feel without
 *   risking the renderer's hot path.
 * ------------------------------------------------------------------ */

const CombatFX = (function () {
    'use strict';

    let _THREE = null;
    let _scene = null;
    let _camera = null;
    let _weaponHand = null;
    let _muzzleSprite = null;
    let _muzzleLight = null;
    let _flashTime = 0;          // seconds remaining
    const FLASH_DURATION = 0.07; // 70 ms — sub-frame at 60Hz x 4 frames

    // Tracer pool
    const TRACER_POOL_SIZE = 4;
    const TRACER_LIFETIME = 0.14; // seconds
    const _tracers = [];          // {line, life, maxLife}
    let _tracerCursor = 0;

    /**
     * Build a soft additive radial gradient texture on a canvas.
     * Used as the muzzle flash sprite map. White-yellow-orange burst
     * with 4 spike rays for that classic firearm look.
     */
    function _makeMuzzleTexture(THREE) {
        const SIZE = 256;
        const c = document.createElement('canvas');
        c.width = SIZE; c.height = SIZE;
        const g = c.getContext('2d');

        // Step 1: outer soft glow (orange → transparent)
        const grad = g.createRadialGradient(SIZE/2, SIZE/2, 0, SIZE/2, SIZE/2, SIZE/2);
        grad.addColorStop(0.00, 'rgba(255,250,220,1.00)'); // hot core
        grad.addColorStop(0.18, 'rgba(255,230,140,0.95)'); // yellow
        grad.addColorStop(0.45, 'rgba(255,140,40,0.55)');  // orange
        grad.addColorStop(0.80, 'rgba(180,70,20,0.18)');   // red-fade
        grad.addColorStop(1.00, 'rgba(0,0,0,0)');           // transparent
        g.fillStyle = grad;
        g.fillRect(0, 0, SIZE, SIZE);

        // Step 2: 4 cardinal "lens spike" rays (long thin gradients)
        g.globalCompositeOperation = 'lighter';
        g.translate(SIZE/2, SIZE/2);
        for (let i = 0; i < 4; i++) {
            g.save();
            g.rotate(i * Math.PI / 2);
            const rg = g.createLinearGradient(0, 0, 0, SIZE/2);
            rg.addColorStop(0.00, 'rgba(255,240,180,0.85)');
            rg.addColorStop(0.30, 'rgba(255,200,80,0.35)');
            rg.addColorStop(1.00, 'rgba(0,0,0,0)');
            g.fillStyle = rg;
            g.fillRect(-SIZE/64, 0, SIZE/32, SIZE/2);
            g.restore();
        }
        // 4 diagonal half-spikes for variety
        for (let i = 0; i < 4; i++) {
            g.save();
            g.rotate(Math.PI/4 + i * Math.PI / 2);
            const rg = g.createLinearGradient(0, 0, 0, SIZE/3);
            rg.addColorStop(0.00, 'rgba(255,220,150,0.55)');
            rg.addColorStop(1.00, 'rgba(0,0,0,0)');
            g.fillStyle = rg;
            g.fillRect(-SIZE/96, 0, SIZE/48, SIZE/3);
            g.restore();
        }

        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        return tex;
    }

    function _buildMuzzleSprite(THREE, weaponHand) {
        const tex = _makeMuzzleTexture(THREE);
        const mat = new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            depthTest: true,
            opacity: 0.0,         // hidden by default; .fire() ramps to 1
            color: 0xfff4c0,       // slight warm tint
        });
        // Plane facing +Z (toward camera in 1P viewmodel space, since the
        // weapon is at z=-0.32 and barrel pointing at z=-0.30 + further).
        const geo = new THREE.PlaneGeometry(0.45, 0.45);
        const sprite = new THREE.Mesh(geo, mat);
        // Place at the named muzzle anchor on the new R32.13 rifle.
        // Anchor is at local (0, 0.005, -0.420) in weaponHand space; we
        // parent the sprite to the anchor so any future weapon-bob/recoil
        // animation moves the flash with the muzzle automatically.
        const anchor = (typeof window !== 'undefined' && window._weaponMuzzleAnchor) || null;
        if (anchor) {
            sprite.position.set(0, 0, 0);
            anchor.add(sprite);
        } else {
            // Fallback to old barrel-tip math if anchor not set yet
            sprite.position.set(0, 0.005, -0.420);
            weaponHand.add(sprite);
        }
        // Face the camera (looks down +Z in viewmodel space because
        // weaponHand is parented to camera; +Z = behind in cam-space).
        // The plane's default orientation is fine for that.
        sprite.frustumCulled = false;
        sprite.renderOrder = 999; // draw after everything else for cleaner additive
        // (sprite already added to either anchor or weaponHand above)

        // R32.13: also add a tiny short-lived point light so the flash
        // illuminates the gun model itself (and walls behind it in 1P).
        const light = new THREE.PointLight(0xffd070, 0.0, 6.0, 2.0);
        if (anchor) {
            anchor.add(light);
        } else {
            light.position.set(0, 0.005, -0.440);
            weaponHand.add(light);
        }

        return { sprite, light };
    }

    function _buildTracerPool(THREE, scene) {
        // Each tracer is a 2-vertex Line with custom additive material.
        const mat = new THREE.LineBasicMaterial({
            color: 0xffd070,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            opacity: 0.0,
            linewidth: 1, // capped to 1 by most browsers; the additive glow does the visual work
        });
        for (let i = 0; i < TRACER_POOL_SIZE; i++) {
            const positions = new Float32Array([0, 0, 0, 0, 0, 0]);
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geo.computeBoundingSphere();
            const line = new THREE.Line(geo, mat.clone());
            line.frustumCulled = false;
            line.renderOrder = 998;
            line.visible = false;
            scene.add(line);
            _tracers.push({ line, life: 0, maxLife: TRACER_LIFETIME });
        }
    }

    /**
     * Compute the world-space position of the gun barrel tip and the
     * aim point under the crosshair (R31.7-manus already exposes the
     * latter on window._tribesAimPoint3P).
     * Returns null if data isn't ready (game not yet running).
     */
    function _getFireEndpoints() {
        if (!_weaponHand || !_camera) return null;
        // Gun tip: prefer the muzzle anchor world-position when available
        const anchor = window._weaponMuzzleAnchor;
        const start = new _THREE.Vector3();
        if (anchor) {
            anchor.getWorldPosition(start);
        } else {
            start.set(0, 0.005, -0.420);
            _weaponHand.localToWorld(start);
        }
        // Aim point: prefer the world aim-point, else camera-forward * 200.
        const aim = window._tribesAimPoint3P;
        let end;
        if (aim && typeof aim.x === 'number') {
            end = new _THREE.Vector3(aim.x, aim.y, aim.z);
        } else {
            const fwd = new _THREE.Vector3(0, 0, -1);
            fwd.applyQuaternion(_camera.quaternion);
            end = _camera.position.clone().add(fwd.multiplyScalar(200));
        }
        return { start, end };
    }

    return {
        init(scene, camera, weaponHand, THREE) {
            _scene = scene;
            _camera = camera;
            _weaponHand = weaponHand;
            _THREE = THREE;
            const { sprite, light } = _buildMuzzleSprite(THREE, weaponHand);
            _muzzleSprite = sprite;
            _muzzleLight = light;
            _buildTracerPool(THREE, scene);
            console.log('[R32.13] CombatFX initialized (muzzle flash + tracer pool)');
        },

        fire() {
            if (!_muzzleSprite) return;
            // Reset flash timer + randomize rotation each shot
            _flashTime = FLASH_DURATION;
            _muzzleSprite.material.opacity = 1.0;
            _muzzleSprite.rotation.z = Math.random() * Math.PI * 2;
            // Slight scale jitter for variety (0.85–1.15x)
            const s = 0.85 + Math.random() * 0.30;
            _muzzleSprite.scale.set(s, s, 1);
            if (_muzzleLight) _muzzleLight.intensity = 2.5;

            // Spawn one tracer
            const ep = _getFireEndpoints();
            if (ep) {
                const t = _tracers[_tracerCursor];
                _tracerCursor = (_tracerCursor + 1) % TRACER_POOL_SIZE;
                const arr = t.line.geometry.attributes.position.array;
                arr[0] = ep.start.x; arr[1] = ep.start.y; arr[2] = ep.start.z;
                arr[3] = ep.end.x;   arr[4] = ep.end.y;   arr[5] = ep.end.z;
                t.line.geometry.attributes.position.needsUpdate = true;
                t.line.material.opacity = 0.85;
                t.line.visible = true;
                t.life = TRACER_LIFETIME;
            }
        },

        update(dt) {
            // Flash decay
            if (_flashTime > 0 && _muzzleSprite) {
                _flashTime -= dt;
                const k = Math.max(0, _flashTime / FLASH_DURATION);
                _muzzleSprite.material.opacity = k;
                if (_muzzleLight) _muzzleLight.intensity = 2.5 * k;
                if (_flashTime <= 0) {
                    _muzzleSprite.material.opacity = 0;
                    if (_muzzleLight) _muzzleLight.intensity = 0;
                }
            }
            // Tracer fade
            for (let i = 0; i < _tracers.length; i++) {
                const t = _tracers[i];
                if (t.life > 0) {
                    t.life -= dt;
                    const k = Math.max(0, t.life / t.maxLife);
                    t.line.material.opacity = 0.85 * k;
                    if (t.life <= 0) {
                        t.line.visible = false;
                    }
                }
            }
        },

        // Crosshair hit-flash (extends existing #hit-tick from index.html).
        // Uses CSS animation classes that are added in R32.13.
        flashHit(strong) {
            const t = document.getElementById('hit-tick');
            if (!t) return;
            t.classList.remove('show', 'hide', 'r3213-hit', 'r3213-kill');
            // Force reflow so re-adding the class restarts the animation.
            void t.offsetWidth;
            t.classList.add('show');
            t.classList.add(strong ? 'r3213-kill' : 'r3213-hit');
            clearTimeout(t._r3213Timer);
            t._r3213Timer = setTimeout(() => {
                t.classList.remove('show', 'r3213-hit', 'r3213-kill');
            }, strong ? 480 : 300);
        },
    };
})();

if (typeof window !== 'undefined') {
    window.CombatFX = CombatFX;
}


// ============================================================
// R32.271: Phase System Hook — stub
// Future: STORM phase adds lightning flash to muzzle FX,
// FOG phase dims tracer brightness, NIGHT_OPS adds IR glow, etc.
// ============================================================
if (typeof window !== 'undefined' && window.PhaseSystem) {
    window.PhaseSystem.registerListener({
        onPhaseChange(event) {
            // TODO: Adjust tracer brightness/color based on phase visibility
            // TODO: STORM → occasional lightning white-flash on fire()
            // TODO: NIGHT_OPS → IR-green tint on tracers
        }
    });
}
