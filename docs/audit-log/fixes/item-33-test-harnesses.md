# Item 33 — Visual Test Harnesses (Gate 5) — R32.230

**Gap Analysis Rating:** CRITICAL
**Status:** ✅ RESOLVED
**Commit:** `79746b3` — `test(R32.230): add visual test harnesses for all systems (Gate 5)`

## Problem Statement

Carmack called this the single largest process violation: Gate 5 of the 8-gate feature process requires standalone test harnesses for every visual system, but only `test/buildings_test.html` existed. Every visual module that shipped without a test harness skipped a mandatory gate.

## Solution

Built 10 standalone test harnesses following the `buildings_test.html` template pattern. Each is a self-contained HTML file that:
- Loads minimum dependencies to test one system in isolation
- Has interactive buttons/controls to trigger different states
- Shows FPS counter, draw call count, and system-specific metrics
- Captures console output in an overlay log panel
- Includes automated test assertions that run on load or on button press
- Uses the same `vendor/three/r170/` import map as the game

## Test Harnesses Created

### 1. `test/daynight_test.html` — Day/Night Cycle
- **Controls:** Time-of-day slider (0-24h), freeze/unfreeze, play/fast/rapid speed
- **Readout:** dayMix, sunDir, light intensities, exposure, fog color, color swatches
- **Auto-tests:** Noon/midnight dayMix values, sun elevation, exposure ramp, lerpColors, dispose safety

### 2. `test/rapier_test.html` — Rapier Physics
- **Controls:** Init Rapier, spawn capsule, add box colliders, WASD movement, jump
- **Readout:** Capsule position, grounded state, collider count, step time
- **Auto-tests:** Wall slide blocking, grounding detection, cleanup verification

### 3. `test/particles_test.html` — All Particle Systems
- **Systems:** Ski particles, projectile trails, explosions+sparks, night fairies, jet exhaust
- **Controls:** Toggle each system, trigger explosions, stress test pool exhaustion
- **Readout:** Active counts per system, total particle count, draw calls
- **Auto-tests:** Pool overflow safety for all 4 pooled systems

### 4. `test/terrain_test.html` — Terrain Rendering
- **Controls:** Wireframe/solid toggle, normals visualization, flat/smooth shading, LOD tiers (129/257/513)
- **Readout:** Grid size, world span, height range, vertex/triangle count, cursor position + height
- **Auto-tests:** Height sampling (center, corner, OOB, interpolation continuity)

### 5. `test/camera_test.html` — Camera Modes
- **Modes:** 1st person, 3rd person, spectator orbit, free orbit
- **Controls:** FOV slider, 3P distance, mouse look, WASD movement
- **Readout:** Position, rotation (degrees), forward direction, aim point, player position
- **Auto-tests:** All 4 modes (weapon visibility, player visibility, distance, orbit controls)

### 6. `test/postprocess_test.html` — Post-Processing Pipeline
- **Controls:** Toggle bloom/vignette/grade/grain independently, bloom strength+threshold sliders
- **Features:** Split view (left raw, right post-processed), bypass mode, rebuild pipeline
- **Readout:** Composer state, pass count, per-pass enable state, frame time
- **Auto-tests:** Composer existence, dispose+rebuild, toggle state, nopost bypass

### 7. `test/combat_fx_test.html` — Combat Effects
- **Effects:** Muzzle flash, tracers, shockwave rings, hit/kill flash, decals
- **Controls:** Fire single shots, rapid-fire (hold button), spawn decals
- **Readout:** Active flash/tracer/shockwave/decal counts, total fires
- **Auto-tests:** Pool overflow (tracer/shockwave/muzzle), decal cap enforcement (48)

### 8. `test/minimap_test.html` — Minimap Rendering
- **Controls:** Add mock players, animate movement, toggle 2-team/4-team, zoom, rotation
- **Features:** Small radar + enlarged view, all Canvas2D rendering
- **Readout:** Player count, local team, world range, flag positions
- **Auto-tests:** Player population, 4-team color rendering, drawMinimap safety

### 9. `test/sky_test.html` — Sky Dome
- **Controls:** Time slider, fast/rapid cycle, show dome/clouds/stars independently
- **Readout:** dayMix, sunDir, star opacity, component visibility
- **Auto-tests:** Sky dome mesh detection, star fade at night, star hidden at noon, uniform presence

### 10. `test/integration_full_frame.html` — Full Integration (Gate 6)
- **Systems:** Sky + DayNight + Terrain + Particles + PostFX + Shadows — all active
- **Controls:** Quality tier selector (Ultra/High/Medium/Low/Potato), toggle individual systems
- **Features:** Frame budget bar (16.6ms target), 120-frame benchmark, memory check
- **Readout:** Draw calls, triangles, textures, geometries, shader programs, per-system status
- **Auto-tests:** Avg/P95/Max frame time vs budget, shader program count, texture leak check on rebuild

## Cohort Review (Pass 1)

### Carmack (Performance / Architecture)
**Verdict: APPROVED** — Test harnesses correctly isolate each system with minimal dependency loading. The integration test includes proper frame budget tracking. Pool overflow tests on particles and combat FX verify O(1) allocation patterns. Only concern: the Rapier test creates a new world per init rather than reusing — acceptable for test tooling.

### Muratori (Code Quality / Patterns)
**Verdict: APPROVED** — All harnesses follow the buildings_test.html template: same CSS structure, same logging capture, same overlay pattern, same button styling. The shader code in particles_test.html is correctly cloned from renderer.js rather than reimplemented. Good use of `DynamicDrawUsage` on all particle buffers.

### Ive (Visual Design / UX)
**Verdict: APPROVED** — Consistent dark theme with #FFD479 accents across all 10 harnesses. The DayNight test's color swatches and the PostFX split view are particularly effective for visual verification. Crosshair overlay in camera_test is appropriate.

### Sweeney (Engine Systems)
**Verdict: APPROVED** — Import maps correctly resolve against `../vendor/three/r170/` via `<base href="../">`. Each harness is truly standalone — no WASM dependency, no game state dependency. The sky_test correctly imports from the ES module (`renderer_sky.js`) while minimap_test correctly uses a standalone clone since the original is an IIFE.

### Acton (Testing / QA)
**Verdict: APPROVED** — Each harness includes both manual controls AND automated test assertions. The stress tests (pool exhaustion, decal cap, rapid rebuild) cover the failure modes most likely to regress. The integration benchmark's P95 metric catches jank that average FPS would miss. Recommend adding `test/index.html` as a launcher page in a future pass.

## Summary

10 test harnesses covering all visual systems. Gate 5 compliance restored. The largest process violation identified in the gap analysis is now resolved.
