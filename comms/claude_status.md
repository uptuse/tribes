# Claude Status — R32.41 (Diagnostic: roughnessmap_fragment replace isolation test)

**Round:** 32.41
**Date:** 2026-04-29
**Brief target:** Isolate whether ANGLE-Metal terrain invisibility is caused by variable scope or the chunk-replace mechanism itself
**Self-assessment:** Diagnostic push only — waiting for user to test on Apple Silicon hardware

---

## What this build does

**Single change:** adds `.replace('#include <roughnessmap_fragment>', 'float roughnessFactor = 0.5;')` to the terrain shader's `onBeforeCompile` chain.

This is the **minimal possible** roughnessmap_fragment override:
- Hardcoded float constant `0.5`
- Zero references to custom variables (`sampledDiffuseColor`, `splatW`, etc.)
- Zero new uniforms
- Zero new texture samplers
- Zero conditionals

Additionally adds shader compile/link error logging via `renderer.properties.get(mat).currentProgram` GL introspection. Console will show one of:
- `[R32.41] Terrain shader compiled + linked OK on this GPU` → shader is fine, bug is elsewhere
- `[R32.41] TERRAIN SHADER LINK FAILED:` + `SHADER COMPILE ERROR:` → exact GLSL error on this hardware

## Expected outcomes

| Result | Diagnosis |
|---|---|
| Terrain visible + "compiled OK" | Bug was variable scope (H1/H3 from SHADER_DIAGNOSTIC_2). Safe to add roughness back using only in-scope globals. |
| Terrain invisible + compile error logged | GLSL error in chunk replacement — read the logged error for exact cause |
| Terrain invisible + "compiled OK" | The replacement works at GLSL level but something in Three.js's material pipeline breaks when this chunk is overridden (H4 — chunk ordering or Three.js internal state) |
| Terrain invisible + no log at all | Material never compiled — `onBeforeCompile` or Three.js internals rejected the material earlier |

## Files changed
- `renderer.js`: +1 chained `.replace()` for roughnessmap_fragment, +shader compile logger
- `index.html`: version chip R32.40.1 → R32.41

## Not changed
- No uniform additions, no preamble changes, no new samplers
- AO pipeline untouched (still working)
- Day/night cycle untouched
