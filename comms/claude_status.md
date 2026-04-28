# Claude Status — R32.72

**HEAD:** R32.72 (pushed)
**What shipped:** Jet exhaust particles + Phase 2 VFX research — first visual effect in the effects pipeline.

## Phase 2 Progress
- [x] Research Three.js particle/effect libraries — docs/particle-research.md
- [x] Jet exhaust particles — R32.72
- [ ] Disc/projectile trails — next up
- [ ] Explosion effects
- [ ] Nighttime fairy particles

## R32.72 — Jet exhaust particles

### Research (docs/particle-research.md)
Evaluated five approaches: three.quarks, Three-VFX, three-nebula, TrailRendererJS, custom.
Chose **custom** (Points + BufferGeometry + ShaderMaterial) — zero dependency overhead,
matches vendored Three.js approach, maximum perf control.

### Implementation
384-particle pool with custom ShaderMaterial:
- Additive blending, hot white-yellow core fading to orange edge
- Soft circular falloff via gl_PointCoord distance in fragment shader
- Emits from two thruster nozzles per jetting player (matches mesh positions)
- 0.35s lifetime, 4.5 m/s downward drift with air drag (0.97x/frame)
- Fade-in over first 30% of life, linear fade-out remainder
- Dead particles hidden at y=-9999, circular slot allocation
- Single draw call for all 384 particles across all 16 players
- try/catch wrapped — cosmetic system can't crash the game loop

### Files changed (R32.72)
- `docs/particle-research.md`: new — VFX library evaluation
- `renderer.js`: +143 lines (initJetExhaust, updateJetExhaust, _jetEmit)
- `index.html`: version chip → R32.72
