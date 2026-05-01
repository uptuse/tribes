# Spinfusor Viewmodel Swap — Aurora Pulse Blaster

**Status:** Asset staged at `assets/weapons/aurora_pulse_blaster.glb` (424 KB, 1024² webp PBR, OPAQUE alpha, 3,919 verts). Ready for Claude to wire in.

**What you're replacing:** The spinfusor (weapon index `2`) currently uses the procedural viewmodel built in `renderer.js` `initWeaponViewmodel()` (lines ~3336–3553). The whole roster shares one procedural mesh that gets re-tinted on weapon change in `_syncWeaponModel()` (line ~3316). Only the spinfusor swap is in scope here — the other 8 weapons keep the procedural model.

---

## Asset facts

```
File:        assets/weapons/aurora_pulse_blaster.glb
Size:        424 KB
Triangles:   ~2,962
Vertices:    3,919
Materials:   1  (Material.001 — OPAQUE)
Textures:    baseColor, emissive, normal — all 1024² webp
Skinned:     No (rigid mesh — same as the procedural viewmodel)
Up axis:     Y-up (glTF standard, no rotation fixup needed in code)
Source:      Meshy AI export, FBX → glTF → resize → webp → OPAQUE
```

The asset is camera-facing-agnostic, so you'll need to orient it the same way the procedural viewmodel is oriented (barrel pointing down `-Z` in `weaponHand` local space). Expect to tune `position`, `rotation`, and `scale` to match the existing first-person sight line.

---

## Your task

**Goal:** When the player has weapon index 2 (Spinfusor) equipped, render the Aurora Pulse Blaster GLB instead of the procedural viewmodel. When they switch to any other weapon, the procedural viewmodel returns. The weapon name label still reads "SPINFUSOR".

**Constraints:**
- Do not break the other 8 procedural weapons.
- Do not break the recoil / sway / muzzle-anchor / 1P-only-visibility logic.
- Keep the load asynchronous and don't block the main render loop. The first time the player picks up a Spinfusor, there may be a one-frame stall while the GLB parses; that's acceptable.
- Cache-bust `renderer.js` if you change other modules; bump the version chip.

---

## Implementation plan

### 1. Add a GLB cache and a Spinfusor-specific viewmodel group

Near the other weapon-viewmodel state (around `let _wpnFrameMat = null;`, line ~3300), add:

```js
// R32.278: GLB-backed viewmodel for Spinfusor (weapon idx 2).
// Loads once, swaps in/out by visibility on weapon change.
let _spinfusorGLB = null;          // THREE.Group, the loaded scene
let _spinfusorReady = false;
let _spinfusorMuzzleAnchor = null; // child Object3D for muzzle FX
const _SPINFUSOR_TRANSFORM = {
    // Tune these to align with the procedural viewmodel's sight line.
    // Procedural viewmodel sits at z ≈ −0.45 (camera near plane comment line ~3913).
    position: new THREE.Vector3( 0.05, -0.06, -0.32),
    rotation: new THREE.Euler  ( 0,    Math.PI, 0,    'YXZ'),  // face barrel down -Z
    scale:    0.18,                                              // match procedural viewmodel footprint
};
```

### 2. Load the GLB at boot and stage it as a sibling of `weaponHand`

In `initWeaponViewmodel()`, after `weaponHand = group;` (line ~3550), kick off the async load:

```js
// R32.278: Spinfusor GLB (deferred parent into camera in initStateViews)
const _spinfusorLoader = new GLTFLoader();
_spinfusorLoader.load(
    './assets/weapons/aurora_pulse_blaster.glb',
    (gltf) => {
        const m = gltf.scene;
        // Apply the authored transform
        m.position.copy(_SPINFUSOR_TRANSFORM.position);
        m.rotation.copy(_SPINFUSOR_TRANSFORM.rotation);
        m.scale.setScalar(_SPINFUSOR_TRANSFORM.scale);
        // Render-state hardening — match the procedural viewmodel pattern
        m.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow = false;
            child.receiveShadow = false;
            child.frustumCulled = false;       // viewmodel is always on screen, never cull
            child.renderOrder = 1;             // gun behind arms (procedural arms use renderOrder 2)
            if (child.material) {
                child.material.depthWrite = true;
                child.material.depthTest = true;
            }
        });
        // Muzzle anchor — derive from bbox front for now; can be replaced with a
        // named bone if Meshy embedded one.
        const anchor = new THREE.Object3D();
        anchor.name = 'spinfusorMuzzle';
        const bbox = new THREE.Box3().setFromObject(m);
        anchor.position.set(0, 0, bbox.min.z * _SPINFUSOR_TRANSFORM.scale * 0.5);
        m.add(anchor);
        _spinfusorMuzzleAnchor = anchor;
        m.visible = false;                     // start hidden; _syncWeaponModel toggles
        _spinfusorGLB = m;
        if (camera) camera.add(m);             // sibling of weaponHand, lives in camera local space
        _spinfusorReady = true;
        console.log('[R32.278] Aurora Pulse Blaster loaded —', bbox.getSize(new THREE.Vector3()));
    },
    undefined,
    (err) => {
        console.warn('[R32.278] Aurora Pulse Blaster failed to load:', err);
    }
);
```

If `camera` is not yet defined when this callback fires, store the model and parent it on the next call to `initStateViews()`. Easiest: in `initStateViews()` where `camera.add(weaponHand)` happens (line ~3924), append:

```js
if (_spinfusorGLB && _spinfusorGLB.parent !== camera) camera.add(_spinfusorGLB);
```

### 3. Toggle visibility in `_syncWeaponModel`

The current `_syncWeaponModel` (line ~3316) needs to know whether the current weapon has a GLB override. Replace its body with:

```js
function _syncWeaponModel(curWpn) {
    // Only update on weapon change
    if (curWpn === _lastWpnIdx) return;
    _lastWpnIdx = curWpn;

    const isSpinfusor = (curWpn === 2);
    const useGLB = isSpinfusor && _spinfusorReady;

    // Toggle: GLB visible XOR procedural visible
    if (weaponHand) {
        weaponHand.children.forEach(c => { c.visible = !useGLB; });
    }
    if (_spinfusorGLB) _spinfusorGLB.visible = useGLB;

    const meta = _WPN_META[curWpn] ?? _WPN_META[0];
    if (_wpnFrameMat) _wpnFrameMat.color.setHex(meta.color);

    _wpnLabel.textContent = meta.name.toUpperCase();
    _wpnLabel.style.display = 'block';
    clearTimeout(_wpnLabel._hideTimer);
    _wpnLabel._hideTimer = setTimeout(() => { _wpnLabel.style.display = 'none'; }, 2000);
}
```

### 4. Honour the existing 1P / weapon-hidden visibility logic

Two existing rules currently apply only to `weaponHand`. Mirror them onto `_spinfusorGLB`:

**At line ~4407** (the "Hide weapon viewmodel" block in death/scope/etc.):
```js
if (weaponHand) weaponHand.visible = false;
if (_spinfusorGLB) _spinfusorGLB.visible = false;
```

**At line ~4618** (the 1P-only re-show):
```js
if (weaponHand) weaponHand.visible = _in1P && _lastWpnIdx !== 2;
if (_spinfusorGLB) _spinfusorGLB.visible = _in1P && _lastWpnIdx === 2;
```

(Two narrow conditions instead of the original blanket assignment.)

### 5. Wire the muzzle anchor

In the spot where `window._weaponMuzzleAnchor` is set (right after `weaponHand = group;` line ~3552), replace the unconditional assignment with a getter pattern, or update it on weapon change:

```js
// Inside _syncWeaponModel, at the end:
window._weaponMuzzleAnchor = useGLB && _spinfusorMuzzleAnchor
    ? _spinfusorMuzzleAnchor
    : muzzleAnchorProcedural;  // the anchor created in initWeaponViewmodel
```

If `muzzleAnchorProcedural` isn't currently a module-scoped name, hoist it. The CombatFX init at line ~3934 does not need to change — it gets the muzzle from `window._weaponMuzzleAnchor` per-shot.

### 6. Sway / recoil / kick already work

`_updateViewmodelSway()` (line ~4128) drives `weaponHand.position` and `weaponHand.rotation`. Because `_spinfusorGLB` is a separate object in camera local space, sway will not animate it. Two options:

- **Preferred:** Group `_spinfusorGLB` under `weaponHand` instead of under `camera`. Then it inherits sway / kick / dip for free. Change step 2's parenting from `camera.add(m)` to `weaponHand.add(m)`, and remove the `_SPINFUSOR_TRANSFORM.position` offset that was duplicating the procedural viewmodel's hand position (the spinfusor sits at the same hand position by definition). You'll need to re-tune scale and small position deltas to taste.
- **Alternative:** Mirror the sway math onto `_spinfusorGLB` separately. More code, more drift risk. Don't do this unless option 1 has a problem.

**Use option 1.** Re-parent under `weaponHand`. The toggle in step 3 still uses `_spinfusorGLB.visible`, but the procedural meshes are still toggled via `weaponHand.children.forEach`. Add a guard so the GLB isn't accidentally hidden by that loop:

```js
weaponHand.children.forEach(c => {
    if (c === _spinfusorGLB) return;   // GLB visibility owned by useGLB toggle
    c.visible = !useGLB;
});
```

### 7. Cache-bust

Bump `renderer.js`'s next dependent (or update the script tag in `index.html` for `renderer.js` if it has a `?v=` suffix). Bump the version chip text to a fresh minute.

---

## Acceptance criteria

1. **Load test:** Open the page, watch DevTools Console for `[R32.278] Aurora Pulse Blaster loaded — Vector3 {x: …}`. No 404 on the GLB.
2. **First weapon switch to Spinfusor:** The procedural gun disappears, the Aurora Pulse Blaster appears in the same hand position, oriented forward, no Z-fighting with arms.
3. **Switch away (any other weapon):** Aurora vanishes, procedural reappears, tinted to that weapon's `_WPN_META` colour.
4. **Switch back to Spinfusor:** Aurora reappears, no flicker, no double rendering.
5. **Recoil / kick / jet dip / ski lean:** Aurora animates with the same sway as the procedural viewmodel.
6. **Muzzle FX:** Firing the Spinfusor emits flash/projectile from the new muzzle anchor on the GLB front, not from the procedural muzzle's position.
7. **Death / 3P / scope:** Aurora hides correctly when `_in1P` becomes false or when the player dies.
8. **Performance:** 60 fps on iPad Safari is maintained. The 424 KB GLB + 3 × 1 MB GPU webp uploads should be near-zero hit on a modern device.

---

## Files to touch

- `renderer.js` — all step 1–6 edits
- `index.html` — version chip bump
- (optional) `client/constants.js` — if you want to add a `SPINFUSOR_GLB_PATH` constant

Do **not** modify `assets/weapons/aurora_pulse_blaster.glb` — it's already optimized.

---

## If something doesn't fit

- **Wrong scale:** Tune `_SPINFUSOR_TRANSFORM.scale` (start 0.18, try 0.12–0.30).
- **Wrong rotation:** The Meshy export is +Y up, +Z forward. The procedural viewmodel has barrel pointing −Z in `weaponHand` local space. If the Aurora's barrel points the wrong way after re-parenting under `weaponHand`, change `_SPINFUSOR_TRANSFORM.rotation.y` between `0`, `Math.PI`, `Math.PI/2`, `-Math.PI/2`.
- **Z-fighting with arms:** Check `renderOrder`. Procedural arms use `renderOrder = 2` with `depthTest: false`. Aurora at `renderOrder = 1` with `depthTest: true` should sit cleanly behind the arms.
- **Looks too dark / too bright:** The Aurora has a baked emissive map that's already calibrated for ACES tone mapping. If the surrounding scene uses a different tone-mapping operator, you may need to set `material.emissiveIntensity` on the loaded mesh.

— Manus
