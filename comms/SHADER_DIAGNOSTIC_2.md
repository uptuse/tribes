# SHADER_DIAGNOSTIC_2.md — Roughness Bug Persists After Texture-Unit Fix

**Date:** 2026-04-29
**To:** Claude (or any shader dev picking up this thread)
**From:** Manus, on behalf of the user
**Status:** Your R32.40 fix (luminance-derived roughness, 0 new texture units) was reverted at `93ad4a4` because **terrain still rendered invisible on the user's machine**. Game is back to R32.40.1 = R32.38.9 shader + day/night cycle, both confirmed working.

---

## What you did in `ada4de1`

You correctly identified the texture-unit overflow as a **likely** root cause and shipped a clean fix that derives `roughnessFactor` from `dot(sampledDiffuseColor.rgb, vec3(0.299, 0.587, 0.114))` inside `<roughnessmap_fragment>`, bypassing all extra samplers. Beautifully written. No new texture units consumed. Console-logs `renderer.capabilities.maxTextures` for diagnosis.

## What happened

User reported: *"I still don't see the land. Ask claude to look into it again."*

So:
1. **Texture-unit overflow is NOT the only failure mode** (or not the actual one), OR
2. **Even your zero-sampler change is somehow tripping a different bug**

The user's hardware is **macOS Apple Silicon Safari (or Chrome) on a MacBook**. The browser console output was not captured this round either — sandbox limitation on my end.

## Critical New Evidence

The pattern across all 4 attempts so far:

| Build | What was added inside `mat.onBeforeCompile` | Terrain visible? |
|---|---|---|
| R32.37 (baseline+textures only) | nothing new in shader | ✅ visible |
| R32.37.1 (POM+AO+Rough) | 15 new samplers + 3 new chunk overrides | ❌ invisible (white fog) |
| R32.38 / R32.38.6 / R32.38.7 (AO only) | 5 new AO samplers + AO multiply in `<map_fragment>` | Mixed: R32.38.2 visible (gentle AO worked), R32.38.6 invisible, R32.38.7 invisible |
| R32.39 (Roughness only) | 5 new R samplers + override of `<roughnessmap_fragment>` | ❌ invisible |
| R32.40 = your luminance fix | **0 new samplers** + override of `<roughnessmap_fragment>` | ❌ **still invisible** |

**Your zero-sampler fix still broke terrain.** That means the bug is **not just sampler overflow** — there is also something about **adding ANY content to the `<roughnessmap_fragment>` chunk** (even pure math on already-in-scope vars) that breaks the shader on this user's GPU.

## Hypothesis Refresh

Given R32.40 broke terrain with **zero new texture units**, the active hypotheses are now:

### H1 — `sampledDiffuseColor` is NOT in scope at `<roughnessmap_fragment>`
In some Three.js builds and certain `MeshStandardMaterial` configurations, the chunks may be wrapped in their own `{ }` scope blocks, or `sampledDiffuseColor` may be redeclared inside `<map_fragment>` and not propagated. If so, `sampledDiffuseColor.rgb` references an undeclared identifier in `<roughnessmap_fragment>` → GLSL compile error → silent fallback → invisible terrain.

**Quick test:** instead of `sampledDiffuseColor.rgb`, use a known-global like `vUv` or `gl_FragCoord.xy * 0.001` and compute roughness from that. If terrain renders, scope was the issue.

### H2 — Three.js's auto-injected `roughnessmap_fragment` declaration of `roughnessFactor` clashes
Standard `<roughnessmap_fragment>` declares: `float roughnessFactor = roughness;` Then your replacement also declares `float roughnessFactor = roughness;` inside an `if`. If the chunk is included verbatim somewhere else too, you get a duplicate declaration → compile error.

**Quick test:** rename your local var to `_rfMine`, drop the `if`, and just write `roughnessFactor = (uUseRoughness > 0.5) ? clamp(_rfMine, 0.55, 0.98) : roughness;`

### H3 — `splatW` vs `vSplat` scope drift across chunks on Three r170+
`splatW` is declared inside `<map_fragment>` but consumed in `<roughnessmap_fragment>`. On some platforms the chunk inliner might wrap each chunk in its own block. If so, `splatW` is not visible at `<roughnessmap_fragment>` → reference error → silent compile failure.

**Quick test:** in your roughness chunk, only reference `vSplat` (a `varying` that's always in scope), not `splatW`.

### H4 — Tone-mapping output replacement order
After R32.40, our `mat.onBeforeCompile` chain is: chunk-replace, chunk-replace, chunk-replace... and we also depend on Three's auto-generated PBR pipeline order. If your roughness override happens to land **after** Three has already inlined `roughnessmap_fragment` content (which it sometimes does in advance for `<output_fragment>` lighting), the override may be a no-op AND introduce parse errors that linker-eats silently.

**Quick test:** wrap your replacement in a try/catch in the JS to log if Three's chunk replacement actually finds the `#include <roughnessmap_fragment>` substring. If `replace()` returns the same string unchanged, the chunk wasn't there to override.

### H5 — Apple Silicon Metal driver bug
On macOS, Three.js → ANGLE → Metal. There are known cases where Metal's GLSL→MSL translator chokes on `mix(float, float, float)` with const args, or on `clamp` chained with other operators inside `if`. The compile may produce invalid MSL silently and the fragment shader is replaced with a default that outputs `discard;` for some pixels.

**Quick test:** simplest possible roughness override:
```glsl
.replace('#include <roughnessmap_fragment>', 'float roughnessFactor = 0.5;')
```
If terrain renders → it's something in the math complexity. If terrain still invisible → the chunk-replace itself is breaking on this hardware.

## What I Need From You

1. **Pick one of H1-H5** to test next, ideally the one with the smallest possible diff
2. **Add a console.log inside the JS** so when terrain breaks, the user can read the maxTextures number AND the actual GLSL compile error
3. The user is on **macOS** — please assume Apple Silicon + Metal pipeline as the runtime
4. **Smallest possible diff per push** — last 4 attempts have all been "add roughness" of various complexity. Maybe try just `.replace('#include <roughnessmap_fragment>', 'float roughnessFactor = 0.5;')` to test if it's the chunk-replace mechanism itself

## Repository State

- HEAD: `93ad4a4` (R32.40.1) — your roughness commit reverted, terrain working
- The reverted commit you can re-apply: `ada4de1`
- Diagnostic brief 1 (the original handoff): `comms/SHADER_DIAGNOSTIC.md`
- This brief: `comms/SHADER_DIAGNOSTIC_2.md`
- Day/night cycle (R32.40, additive, working): unchanged in renderer.js DayNight module + index.html clock-chip

## How To Reproduce

User can navigate to https://uptuse.github.io/tribes/ , spawn into the map, and look at the ground around them. The "broken" state is **no land visible** (sky, buildings, particles, but no terrain mesh below). The "working" state is the painterly green/dirt/rock ground with day/night-cycle lighting.

To re-apply your prior fix for retesting:
```bash
git revert 93ad4a4
```
That brings R32.40 back; user hard-refreshes to see if it's still broken.

Thanks. Sorry for the noise.
