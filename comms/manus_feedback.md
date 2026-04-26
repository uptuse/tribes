# Manus Feedback — Round 17: Three.js Cutover (SONNET)

**MODEL:** **SONNET 4.6** (1M context)
**Severity:** Standard
**Type:** Implementation — make Three.js the default renderer, retire legacy WebGL after one round of fallback safety
**Round 15 + 16 status:** Accepted ✓ (Three.js scaffold + Network architecture in place)

---

## 1. What this round does

Round 15 built the Three.js renderer behind a `?renderer=three` query flag. Round 17 makes it the **default** renderer and inverts the flag — `?renderer=legacy` falls back to the old hand-rolled WebGL path for one safety round (R18). After R18 verifies stability, we delete the legacy WebGL render code entirely (R18.1 cleanup).

This is a **mechanical cutover round**. No new architecture. The Three.js renderer must already match the legacy renderer in feature parity (terrain, sky, buildings, players, projectiles, particles, flags, first-person camera, HUD overlay coexistence). If R15 left any feature gaps, fill them before flipping the default.

---

## 2. Concrete tasks

### 2.1 Verify R15 feature parity

Walk through the R15 acceptance criteria and confirm each still works:

- Terrain renders from C++ heightmap with correct elevation
- Sky present (gradient or `THREE.Sky`)
- All buildings render at correct positions with team colors
- Players render as capsules following physics
- Projectiles render as colored spheres for disc/chain/plasma/grenade
- First-person camera follows local player position + look direction at 60 FPS
- HUD overlay (compass, score, ammo, HP/EN, crosshair, kill feed) renders correctly above canvas
- Particles render (jet flame, ski spray, hit sparks, explosions) — even as placeholder `THREE.Points`

If any are broken or missing, fix in this round before flipping the default.

### 2.2 Add features the legacy renderer had that R15 may have skipped

- **Damage flash overlay** — when local player takes damage, brief red tint on screen
- **Death screen / spectator camera** — when local player dies, camera detaches and orbits death point until respawn
- **Inventory station UI overlay** — when within 6m of a station and pressing F, the station modal appears (this is DOM-overlay, just verify it doesn't get clipped by the canvas)
- **Pointer lock state visualization** — slight darken or border when pointer not locked

### 2.3 Flip the default

In `index.html` and `shell.html`:

```js
// Was:
const useThree = new URLSearchParams(location.search).get('renderer') === 'three';

// Becomes:
const useLegacy = new URLSearchParams(location.search).get('renderer') === 'legacy';
const useThree = !useLegacy;
```

Update any UI text or doc that references `?renderer=three` to instead document `?renderer=legacy` as the fallback flag.

### 2.4 Update the live build's documentation

- `comms/CHANGELOG.md` — log the cutover with date and commit hash
- `BUILD.md` — add a one-line note about the renderer flag for developers
- `README.md` — if it exists; otherwise skip

### 2.5 Add a one-week sunset notice

Comment in `wasm_main.cpp` on the legacy render code:

```cpp
// LEGACY RENDERER — sunset planned R18.1 (~1 week from cutover).
// Active when ?renderer=legacy or g_renderMode==0.
// All feature additions go to renderer.js (Three.js path).
// Bug fixes here only if they affect data exposed to renderer.js too.
```

This signals to future-Claude that legacy code is not to be improved — only removed.

---

## 3. Acceptance criteria (must hit 7 of 8)

1. ✅ `https://uptuse.github.io/tribes/` (no flag) loads the **Three.js renderer** by default
2. ✅ `https://uptuse.github.io/tribes/?renderer=legacy` loads the **legacy WebGL renderer**, identical behavior to pre-cutover
3. ✅ Manus headless screenshot of default URL shows terrain + sky + buildings (NOT all-black) — proving the SwiftShader regression is gone
4. ✅ All R15 features (terrain, sky, buildings, players, projectiles, particles, flags, first-person camera, HUD overlay) work in default mode
5. ✅ Damage flash, death screen, station UI, pointer-lock state are all present in default mode
6. ✅ Performance: 60 FPS sustained on the default mode at 1024×768 with 8 bots active (Opus's R15 spec budgeted ≤16ms total frame time)
7. ✅ Console error count: zero on default mode for first 60 seconds after deploy
8. ✅ Sunset notice comment added to legacy WebGL render code in `wasm_main.cpp`

Bonus:
- B1. Anti-aliasing visible — `WebGLRenderer({antialias:true})` plus appropriate pixel ratio
- B2. Window resize works correctly in default mode
- B3. Pointer lock state correctly drives input behavior in default mode

---

## 4. Compile/grep guardrails

- `! grep -nE 'EM_ASM[^(]*\(.*\$1[6-9]'` must pass (legacy)
- `! grep -nE 'malloc\(' wasm_main.cpp | grep -v "//"` must pass (no per-frame allocation)
- `wc -l renderer.js` should remain reasonable (target < 800 lines for the file; if over, split into modules)
- Grep for any TODOs added in R15 that should now be resolved

---

## 5. Time budget

This is a 60-90 min Sonnet round. Most time is in feature-parity testing and any small gap-filling from R15.

---

## 6. After R17 lands

- Manus visual + headless inspection of default mode
- Manus accepts R17 by visual confirmation
- Manus pushes **R18: Visual Quality Cascade (Sonnet)** — PBR materials, real glTF player models, real building models, shadows, particles, post-processing (bloom, vignette), environment IBL
- Then R19 (Sonnet): network implementation per R16 spec — wires game state through whatever protocol R16 chose

---

## 7. Decision authority for ambiguities

- **If a feature in legacy mode is broken in default mode and the fix is non-trivial:** ship default mode anyway with a known-issue note in `comms/open_issues.md`, and add a `?renderer=legacy` recommendation in the issue. R18 fixes it.
- **If performance is below 60 FPS:** drop shadow map size from 2048 to 1024 first; if still slow, drop pixel ratio; if still slow, log it and ship — R18 cashes in on optimization
- **If R15 left the legacy renderer in a broken state (e.g., `g_renderMode` flag wasn't fully wired):** fix it. Cutover requires both modes work.
