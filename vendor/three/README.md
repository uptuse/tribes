# Three.js r170 — Vendored

Vendored locally to eliminate CDN dependency.

## ⚠️ Version Pin — Do Not Casually Upgrade

renderer.js uses **6 `onBeforeCompile` hooks** that do string-replacement on Three.js
internal shader chunks. These hooks are fragile — if Three.js renames, restructures, or
removes the targeted GLSL variables/functions, the terrain goes grey, interiors go black,
and there is NO runtime error. Failure is silent.

### Hooks that depend on Three.js internals:
1. **Terrain shader** — replaces `#include <map_fragment>` with custom splat blending
2. **Interior materials** — patches normal calculation for flat-shaded geometry
3. **Building PBR patches** — adjusts roughness/metalness for team-colored surfaces
4. **Toon pass** — injects quantized color ramp into fragment shader
5. **Decal depth** — modifies depth write behavior for polygon-offset decals
6. **Grass instancing** — patches vertex shader for instance matrix + wind animation

### Update procedure:
1. Download new version into `r<version>/`
2. **Test ALL 6 onBeforeCompile hooks** — verify terrain, interiors, buildings, toon, decals, grass visually
3. Update importmap in `index.html` AND `shell.html`
4. Run the full game for at least one complete day/night cycle
5. Test on low/medium/high/ultra quality tiers
6. Only then delete the old version directory
