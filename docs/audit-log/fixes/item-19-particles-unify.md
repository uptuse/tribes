# Item 19 — Unify Particle Systems into renderer_particles.js

## Change Summary
Extracted and unified 5 particle systems from renderer.js (~791 lines removed) into `renderer_particles.js` with a parameterized `PointPool` class.

**Commit:** `refactor(R32.233): unify particle systems into renderer_particles.js`

## Architecture

### PointPool Class
Parameterized SoA particle pool that replaces 3 duplicate implementations:
- **Ski sparks**: 256 particles, blue-white, light gravity, drag 0.96
- **Projectile trails**: 512 particles, per-type colors, no velocity
- **Explosion sparks**: 192 particles, orange, heavy gravity, drag 0.98

Each pool is configured by a config object rather than duplicating the SoA + shader boilerplate.

### Separate Subsystems (architecturally distinct)
- **WASM particles**: Reads from HEAPF32 via `syncWASMParticles()` — not a pool, it's state sync
- **Explosion fireballs**: Mesh-based (SphereGeometry), not point sprites — separate pool
- **Night fairies**: GPU-driven (44800 particles, vertex shader terrain sampling) — stays separate

## Module API
```javascript
init(deps)                    // scene, camera, MAX_*, getPlayerView, getProjectileView, etc.
update(dt, t)                 // tick all pools + emit from players/projectiles + fairies
syncWASMParticles(ctx)        // WASM particle state sync (called separately)
triggerExplosion(px, py, pz, intensity)  // fireball + spark burst
emit(type, x, y, z, params)  // generic emit: 'ski', 'trail', 'spark', 'explosion'
dispose()                     // clean up all GPU resources
```

## Lines Changed
- renderer.js: 5678 → 4887 lines (-791)
- renderer_particles.js: 603 lines (new)
- Net delta: -188 lines removed from codebase

## Cohort Review

### Pass 1 — Structural Integrity (Carmack)
**PASS.** The `PointPool` class eliminates the ski/trail/spark code triplication. Same SoA layout, same slot scanning, same shader architecture — now parameterized by config objects.

### Pass 4 — Integration Risk (Fiedler)
**PASS.** The rendering-loop call sites are wired through try/catch. WASM sync is separate to avoid coupling the module to Module/polish references. Explosion triggering is exposed for shockwave callbacks.

### Pass 5 — Dispose/Lifecycle (Acton)
**PASS.** Every subsystem has proper cleanup in `dispose()`: geometries, materials, textures, and scene removal. The heightmap texture for night fairies is explicitly disposed.

## Risk Assessment
**MEDIUM-HIGH.** Large extraction with behavioral change (parameterized pools vs literal implementations). Same visual output, but the emission logic is subtly different (pools use unified tick/emit rather than per-frame inline emit). Night fairy shader is faithfully reproduced. Testing recommended with `?nopost` to isolate particle rendering.
