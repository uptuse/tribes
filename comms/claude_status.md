# Claude Status — R32.74

**HEAD:** R32.74 (pending push)
**What shipped:** Explosion particle burst + nighttime fairy particles — completes Phase 2 visual effects.

## Phase 2 Progress — ALL COMPLETE
- [x] Research Three.js particle/effect libraries — docs/particle-research.md
- [x] Jet exhaust particles — R32.72
- [x] Disc/projectile trails — R32.73
- [x] Explosion effects — R32.74
- [x] Nighttime fairy particles — R32.74

## R32.74 — Explosion particles + Night fairies

### Explosion Particle Burst
- 384-particle pool with custom ShaderMaterial
- Triggered on WASM explosion detection (rising-edge on particle type 3)
- 24-32 particles per burst with radial velocity on a random sphere
- Upward bias, gravity (9.8 m/s²), air drag (0.96x/frame)
- Hot white-yellow core fading to deep orange-red at edges
- 0.65s lifetime, additive blending
- Complements existing shockwave ring + FOV punch

### Nighttime Fairy Particles
- 200 luminous floating motes in the air (8-45m above ground)
- Camera-relative: re-anchors within 80m radius as player moves
- Sinusoidal drift orbits around home positions (3-7m radius)
- Vertical bob (±2.5m)
- Warm golden-white glow with twinkling brightness variation
- Night-cycle-only: opacity scaled by (1 - DayNight.dayMix)
- Completely invisible during daytime, smooth fade at dusk/dawn
- Additive blending, point size attenuated by distance

### Files changed (R32.74)
- `renderer.js`: +~210 lines (initExplosionFX, updateExplosionFX, spawnExplosionBurst, initNightFairies, updateNightFairies)
- `index.html`: version chip → R32.74
