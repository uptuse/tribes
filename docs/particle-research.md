# Particle & VFX Research for Tribes Browser (Phase 2)

## Libraries Evaluated

### 1. three.quarks (⭐ Recommended for complex effects)
- **URL**: https://github.com/Alchemist0823/three.quarks
- **CDN**: https://www.jsdelivr.com/package/npm/three.quarks (v0.17.0)
- **Features**: Billboard, Stretched Billboard, Mesh, Trail renderers; batched rendering minimizes draw calls; visual editor at quarks.art/create; JSON effect export/import; Unity Shuriken import
- **Emitters**: Point, Sphere, Hemisphere, Cone, Circle, Mesh Surface, Grid
- **Behaviors**: Color/Size/Rotation over lifetime, forces, gravity, collision
- **Pros**: Production-ready, actively maintained (367 commits), feature-rich
- **Cons**: Adds dependency (~50KB gzipped), needs vendoring or CDN
- **Verdict**: Great if we need complex multi-emitter effects. Overkill for our needs.

### 2. Three-VFX
- **URL**: https://github.com/mustache-dev/Three-VFX
- **Features**: GPU compute shaders, WebGPU native, WebGL fallback
- **Pros**: Highest performance (GPU simulation)
- **Cons**: WebGPU primary (we use WebGL), R3F-focused, vanilla support "experimental"
- **Verdict**: Skip — wrong renderer target.

### 3. three-nebula
- **URL**: https://discourse.threejs.org/t/nebula-a-fully-featured-particle-system-designer-for-three/21854
- **Features**: Full-featured particle designer
- **Cons**: Less actively maintained, older codebase
- **Verdict**: Skip in favor of three.quarks or custom.

### 4. TrailRendererJS
- **URL**: https://github.com/mkkellogg/TrailRendererJS
- **Features**: 3D object trail renderer for Three.js
- **Pros**: Lightweight, focused on trail effects
- **Cons**: Only does trails, needs integration
- **Verdict**: Good reference for disc trails, but we can do simpler.

### 5. Custom (Points + BufferGeometry + Shaders)
- **URL**: Built-in Three.js, no dependency
- **Features**: Full control, zero overhead
- **Pros**: No bundle bloat, matches vendored Three.js approach, maximum perf control
- **Cons**: More code to write
- **Verdict**: ✅ **Best fit** for our lean, performance-first project.

## Recommendation

**Go custom** using Three.js built-in primitives. Reasons:
1. Performance is priority #1 — we control every allocation
2. Project uses vendored Three.js with no build step — adding npm deps is friction
3. Effects needed are relatively simple (particles, trails, glows)
4. Full control over draw calls and update loop

## Implementation Plan

### Jet Exhaust
- `THREE.Points` with `THREE.BufferGeometry`
- Custom `THREE.ShaderMaterial` with additive blending
- Per-particle: position, velocity, age, size
- Cone emitter at jet nozzle, particles drift downward
- ~50-100 particles per player, pooled

### Disc/Projectile Trails
- `THREE.Line` or `THREE.Points` trail behind each projectile
- Ring buffer of last N positions, fading alpha
- Glow via additive blending + size attenuation

### Explosion Effects
- Burst of particles (100-200) with radial velocity
- Size increase + alpha fade over 0.5s lifetime
- Optional expanding sphere (wireframe) for shockwave
- Additive blending for fiery look

### Nighttime Fairy Particles
- ~200 `THREE.Points` scattered in air volume above terrain
- Slow sinusoidal drift (noise-based)
- Subtle point light emission (one shared light, not per-particle)
- Night cycle only — fade in/out with sun position
- Very low overhead

## Reference Links
- Three.js Points example: https://threejs.org/examples/#webgl_points_waves
- Three.js custom shader particles: https://tympanus.net/codrops/2019/01/17/interactive-particles-with-three-js/
- TrailRendererJS: https://github.com/mkkellogg/TrailRendererJS
- three.quarks (fallback if custom too complex): https://github.com/Alchemist0823/three.quarks
