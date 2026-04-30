# Weapons Overhaul Brief: Visuals, Feel, and Models

**Date:** April 29, 2026
**Target:** `renderer.js`, `renderer_combat_fx.js`, `wasm_main.cpp`
**Objective:** Evolve Firewolf's projectiles from "glowing colored spheres" into the iconic, distinct visual signatures of the Tribes 1 arsenal. Improve the visceral feel of firing (kickback, FOV punch) and provide a low-hanging-fruit path to swap out the procedural viewmodel for real GLTF assets.

---

## Part 1: The Core Problem

The C++ engine currently implements the stats for all 9 canonical Tribes 1 weapons (Disc, Chaingun, Plasma, Mortar, Grenade, Laser, ELF, Blaster, Repair). 

However, the renderer collapses them all into a single visual representation: **a 0.20m emissive sphere**. The only difference is the color (Disc is white, Mortar is orange, Plasma is red-orange). There are no trails, no distinct geometry, no spinning discs, no beams.

We need to break `syncProjectiles()` out of the "one mesh fits all" paradigm and give each weapon its canonical visual signature.

---

## Part 2: Per-Weapon Visual Signatures

Modify `initProjectiles()` and `syncProjectiles()` in `renderer.js` to support per-type geometry and behavior.

### 1. Spinfusor (Disc)
*   **Current:** White sphere.
*   **Target:** A flat cylinder/torus (the "disc") that spins rapidly around its Y-axis as it flies.
*   **Trail:** A tight, bright blue/white energy ribbon trailing directly behind it.
*   **Implementation:** In `syncProjectiles`, if `type === WPN_DISC`, swap the mesh geometry to a `CylinderGeometry(0.25, 0.25, 0.05, 16)` and rotate it by `t * 15.0` on the Y axis. Add a blue point light to the projectile.

### 2. Heavy Mortar
*   **Current:** Orange sphere.
*   **Target:** A heavy, dark metallic shell that leaves a thick, arcing smoke trail.
*   **Trail:** Instead of the generic additive trail, emit dark grey, scaling-up smoke particles from `_trailEmit` when `type === WPN_MORTAR`.
*   **Explosion:** Needs a massive, screen-shaking green/orange explosion (radius 20m).

### 3. Plasma Gun
*   **Current:** Red-orange sphere.
*   **Target:** A teardrop-shaped blob of plasma.
*   **Trail:** A wide, dispersing red/orange energy plume that fades quickly.

### 4. Chaingun
*   **Current:** Yellow sphere.
*   **Target:** Invisible projectile mesh, but leaves a long, stretched yellow/white tracer line.
*   **Implementation:** Set `mesh.visible = false` for Chaingun. In `renderer_combat_fx.js`, use the `spawnTracer` function to draw a stretched line from the muzzle to the projectile's current position.

### 5. Laser Rifle (Sniper)
*   **Current:** Invisible/instant hitscan, but no visual beam.
*   **Target:** An instant, bright red beam that connects the muzzle to the hit point, fading out over 0.5 seconds.
*   **Implementation:** Since it's hitscan, C++ `fireWeapon` needs to send a "LaserHit" event to JS with the impact coordinates. JS then draws a `THREE.Line` from `_weaponMuzzleAnchor` to the hit point and fades its opacity.

---

## Part 3: Visceral Feel (Kickback & Recoil)

The weapons currently feel "floaty" when fired. We need to punch up the physical feedback.

### 1. Viewmodel Recoil (JS)
In `renderer_combat_fx.js`, the `fire()` function should apply a procedural kick to `weaponHand.rotation.x` and `weaponHand.position.z` that springs back over ~150ms.
*   **Mortar:** Massive kick (0.2 rad up, 0.1m back).
*   **Disc:** Medium kick (0.1 rad up, 0.05m back).
*   **Chaingun:** Continuous rapid vibration.

### 2. Physics Kickback (C++)
In `wasm_main.cpp`, `weapons[WPN_DISC].kickback` is set to 150, but the application in `fireWeapon` is:
`if(w.kickback>0) p.vel -= fwd * (w.kickback * 0.01f);`
This only pushes the player back 1.5 m/s, which is barely noticeable.
**Fix:** Increase the multiplier or base kickback values so firing a Mortar or Disc mid-air noticeably alters the player's trajectory (a core Tribes movement mechanic).

### 3. FOV Punch (JS)
Currently, `_fovPunchExtra` only triggers on explosions. Add a smaller FOV punch (e.g., +1.0 degree) directly on the `fire()` event for heavy weapons like the Mortar and Disc to simulate the concussive force of launching the projectile.

---

## Part 4: Low-Hanging Fruit: Weapon Model Swaps

The current weapon viewmodel is a procedural THREE.js group made of gray boxes (`initWeaponHand` in `renderer.js`). It looks like a placeholder.

**The Swap Path:**
1.  Download the **"Sci-Fi Modular Gun Pack" by Quaternius** (CC0 license, free). It contains 10+ pre-assembled sci-fi weapons in `.glb` format.
2.  Place `AssaultRifle.glb` (for Chaingun) and `RocketLauncher.glb` (for Spinfusor/Mortar) in the `assets/models/` directory.
3.  In `renderer.js`, replace the procedural box building in `initWeaponHand` with the existing `GLTFLoader`:
    ```javascript
    const loader = new GLTFLoader();
    loader.load('assets/models/AssaultRifle.glb', (gltf) => {
        const gun = gltf.scene;
        gun.scale.set(0.5, 0.5, 0.5);
        gun.position.set(0.1, -0.2, -0.4); // Position relative to camera
        
        // Re-bind the muzzle anchor for CombatFX
        const muzzleAnchor = new THREE.Object3D();
        muzzleAnchor.position.set(0, 0.05, -0.5);
        gun.add(muzzleAnchor);
        window._weaponMuzzleAnchor = muzzleAnchor;
        
        weaponHand.add(gun);
    });
    ```
4.  This instantly replaces the gray boxes with a textured, detailed sci-fi weapon, while keeping all the existing sway, bob, and CombatFX muzzle flash logic intact.
