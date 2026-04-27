# Terrain shader diagnostic — "invisible terrain on PBR-chunk override"

**Status:** reproducible hard failure. Game at R32.39.1 is stable; attempts to add any PBR feature (Roughness, AO crank, POM) via shader chunk override cause the terrain mesh to render **fully invisible** (you see sky, buildings, and HUD — no ground at all, not black, not grey, just missing).

**Repo:** https://github.com/uptuse/tribes
**Live:** https://uptuse.github.io/tribes/
**Engine:** Three.js r156 (via CDN in `index.html`), `MeshStandardMaterial` with custom `onBeforeCompile`.
**Target GPU:** Apple Silicon (Safari / Metal / ANGLE); Chromium sandbox (Linux, likely software WebGL fallback) also repros.

---

## What works (R32.38.9, current live)

- Terrain `MeshStandardMaterial` with `map: grassC`, `normalMap: grassN`, `roughness: 0.93`.
- `onBeforeCompile` replaces three chunks: `uniform vec3 diffuse;` (to declare extra samplers/varyings/helpers), `#include <map_fragment>` (custom splat-blend of 5 color textures → `sampledDiffuseColor` → `diffuseColor *= sampledDiffuseColor`), and `#include <normal_fragment_maps>` (custom splat-blend of 5 normal textures).
- Extra vertex attrs: `aSplat (vec4)` and `aSmoothNormal (vec3)`. Varyings `vSplat`, `vWorldXZ`, `vWorldY`.
- Custom uniforms for 10 color+normal samplers, 5 AO samplers, `uTileMeters`, `uTerrainSize`, wind, fuzz, plus `uUseRoughness`, `uUseAO`, `uUsePOM`.
- **AO is wired** (gently): inside the `<map_fragment>` replacement, `if (uUseAO > 0.5) { ... ; sampledDiffuseColor.rgb *= aoT; }`. Works fine.

## What breaks (anything past R32.38.9)

Any of the following, added in isolation, makes the terrain mesh **invisible** (mesh present in scene graph, vertex shader runs — we can still see some slope-aware shadows on other geo — but the terrain surface itself disappears, as if fragment shader is `discard`-ing every fragment or outputting `gl_FragColor = vec4(0,0,0,0)` with alpha-blending somehow enabled):

1. **Adding `#include <roughnessmap_fragment>` replacement** that samples 5 new roughness samplers and writes `roughnessFactor = ...` (R32.39).
2. **Cranking the existing AO multiplier** from `mix(1.0, ao, 0.85)` to `pow(ao, 2.5)` (R32.38.3–38.4). Terrain turned black and then invisible.
3. **Smoothstep-remapping AO** to `smoothstep(0.20, 0.60, aoT)` then `mix(0.15, 1.0, aoCrev)` (R32.38.6). Invisible.
4. **Hard-flooring AO** to `mix(0.65, 1.0, aoT)` (R32.38.7). Still invisible.

In all four failure modes, the HUD version chip updates correctly (JS ran fine), FPS chip still ticks (renderer still running), and no JS console errors are visible to the user. The GLSL must be compiling on some path because the renderer doesn't halt — but output is fully absent.

## Key hypotheses still live

| # | Hypothesis | Evidence for | Evidence against |
|---|---|---|---|
| 1 | Fragment shader compile fails silently → Three.js swaps in an `onError`-fallback material with `visible=false` or `alpha=0` | Explains total absence; explains why tiny tweaks cascade | `onError` in Three r156 typically logs to console; user report says no red errors |
| 2 | Sampler-unit limit exceeded on user's platform (WebGL2 MAX_FRAGMENT_TEXTURE_IMAGE_UNITS) when 5 more samplers added | AO @ 5 samplers works, roughness @ 5 more (= 15+Three internals) breaks. 16 is the WebGL2 minimum | Desktop GPUs typically allow 32+; Mac GPU certainly does |
| 3 | `gMix`, `splatW`, or `tUv` declared in `<map_fragment>` replacement aren't visible inside `<roughnessmap_fragment>` chunk, causing undefined-identifier compile error | Would explain R32.39 specifically | Both chunks inline into same `main()` function body with same scope; AO shares same vars and works |
| 4 | `roughnessFactor` is declared elsewhere by Three's chunk system at outer scope; redeclaring as a `float` inside our chunk is illegal | Standard GLSL: you can't redeclare a local in the same scope | Three's `<roughnessmap_fragment>` normally does `float roughnessFactor = roughness; if (USE_ROUGHNESSMAP) { ... }`. My replacement also declares `float roughnessFactor = roughness;`. If Three's declaration is `OUTSIDE` my include, this is a double-decl. |
| 5 | Math-induced division by zero or NaN propagation somewhere that drops `diffuseColor.a` to 0 | Could explain invisible-but-not-black | Terrain material has `transparent: false` (needs verification); should be opaque regardless of color-alpha |

**Highest-ROI hypothesis: #4** — `roughnessFactor` is very likely already declared by Three before my include. My replacement starts with `float roughnessFactor = roughness;` — **double declaration, illegal GLSL**. Same pattern for other chunks: map_fragment doesn't have this problem because `diffuseColor` is a Three-declared `vec4` that I just multiply into (never re-declare). Roughness chunk, I redeclare `roughnessFactor`. Boom.

**If hypothesis #4 is right, the fix is:**
```glsl
// WRONG:
.replace('#include <roughnessmap_fragment>',
  `float roughnessFactor = roughness;   // <- redeclaration
   if (uUseRoughness > 0.5) { ... roughnessFactor = ...; }`)

// RIGHT (just assign, don't re-declare):
.replace('#include <roughnessmap_fragment>',
  `roughnessFactor = roughness;         // <- plain assign
   if (uUseRoughness > 0.5) { ... roughnessFactor = ...; }`)
```
But wait — if `roughnessFactor` isn't declared at all without our include, the assignment would ALSO fail. Need to verify Three's actual injection of `roughnessFactor`.

Three r156 `roughnessmap_fragment.glsl.js` is literally:
```glsl
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
  roughnessFactor *= texelRoughness.g;
#endif
```
Which confirms it declares `roughnessFactor`. So my replacement of the entire `#include` removes both the declaration AND the texture sample. My replacement then **also declares `float roughnessFactor = roughness;`** — but now there's no outer declaration to collide with (since I REPLACED the whole include). So hypothesis #4 is actually **wrong**.

...unless Three r156 is pre-injecting `roughnessFactor` somewhere ELSE before the chunk? Unlikely.

## What I want Claude to check

1. **Exact GLSL compile status at the moment of failure.** I need to see the WebGL error log, not guess. Please open the live game with R32.39 temporarily re-applied (it's at git SHA `16a2c10`), open Chrome DevTools → Console → filter for "WebGL", and paste the error output.
2. **Three.js r156 `MeshStandardMaterial` shader chunk inlined order.** Is `<roughnessmap_fragment>` guaranteed to run AFTER `<map_fragment>` in the inlined main()? Are the `gMix`, `splatW`, `tUv` declarations I make at top level of my `<map_fragment>` replacement actually at top level, or are they wrapped in a block I'm not seeing?
3. **Test hypothesis #2 (sampler limit)**: instruct Three to dump `renderer.capabilities.maxTextures` and `renderer.capabilities.maxVertexTextures`. If the user's GPU reports ≤16 fragment samplers, we MUST atlas-pack.
4. **Check if `terrainMesh.material.visible` or `terrainMesh.visible` is being toggled false** by something downstream (maybe a quality-tier hook or frustum cull).
5. **Sanity-probe**: simplest possible roughness override — just `roughnessFactor = 0.3;` (constant glossy) instead of sampler-based. If that ALSO makes terrain invisible, then the bug is structural (chunk replacement breaks something in Three's pipeline), not sampler-related.

## Files to review

- `/home/ubuntu/tribes/renderer.js` lines **~900–1150**: terrain material setup, `onBeforeCompile`, shader chunk replacements
- `/home/ubuntu/tribes/renderer.js` lines **~1128–1140**: `window.__tribesSetTerrainPBR` live-toggle hook
- `/home/ubuntu/tribes/comms/CHANGELOG.md`: full history of what each R32.37.x / R32.38.x / R32.39 attempt did

## Reproducer

To reproduce the R32.39 failure locally:
```bash
git checkout 16a2c10    # R32.39
# load live-server or open the file directly; terrain will be invisible
```
To restore:
```bash
git checkout 81db29f    # R32.39.1 — back to working
```

## Diff of R32.39 vs R32.38.9 (the only working→broken delta)

- Added 5 sampler uniform bindings: `uTileGrassR/R2/RockR/DirtR/SandR`
- Added 5 `uniform sampler2D uTile*R` declarations in fragment shader
- Added replacement of `#include <roughnessmap_fragment>` with ~15 lines of custom GLSL that samples the 5 textures and computes `roughnessFactor`
- Changed `uUseRoughness` uniform default from 0.0 to `_pbrInit('pbrRoughness', true)` (i.e., 1.0)

That's it. No changes to vertex shader, no new varyings, no touching the `<map_fragment>` or `<normal_fragment_maps>` overrides.
