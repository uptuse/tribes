# Claude Status — R29 P0 HOTFIX (Black 3D canvas)

**Round:** 29 (SONNET 4.6, P0 emergency)
**Date:** 2026-04-26
**Brief target:** 6/6 criteria required (P0 — all must pass)
**Self-assessment:** All 6 tasks complete; zero shader errors in build. Runtime verification requires the user to open Chrome.

---

## What was broken and why

The game has shipped a **black 3D canvas** since R17. Two compounding bugs:

### Bug A — GLSL precision mismatch (confirmed from live Chrome DevTools)
All 4 vertex shaders (`tVS/oVS/hVS/dtsVS`) had no precision directive → defaulted to `highp`. All 4 fragment shaders had `precision mediump float;`. GLSL ES 3.0 §4.5.4 requires identical precision on shared uniforms. Strict WebGL2 (Mac Chrome) refused to link every program, generating:
```
[SHADER] Link error: Precisions of uniform 'uCamPos' differ between VERTEX and FRAGMENT shaders.
WebGL: INVALID_OPERATION: useProgram: program not valid  (×200+)
```

### Bug B — Three.js never started
`_setRenderMode(1)` + `import('./renderer.js')` lived inside `startGame()` which only fires on PLAY click. Between page load and PLAY, `g_renderMode==0` so the legacy renderer ran its broken shaders continuously. Even after PLAY, it wasn't clear Three.js actually executed `start()`.

---

## Fixes applied (6 tasks)

1. **GLSL precision — all 8 shaders**: added `precision highp float; precision highp int;` to every VS and FS. Changed FS from `mediump` to `highp`. Zero precision mismatch possible on any shared uniform, sampler, or built-in. Also eliminates mediump precision artifacts at >600m terrain distances.

2. **Moved Three.js init to `onRuntimeInitialized`**: removed the init block from `startGame()`, placed it right after the `[R17]` log in `onRuntimeInitialized`. Three.js now takes over before any frame paints. Added full `[R29]` diagnostic logs at every boot step for immediate diagnosability.

3. **`_setRenderMode` export verified**: already in `build.sh` `EXPORTED_FUNCTIONS`. Added `# R29: keep _setRenderMode` comment immediately after the emcc command (comment inside multi-line command breaks bash; moved to after the `}` ).

4. **Renderer diagnostic logs added**:
   - `[R29] renderer.js start() entered`
   - `[R29] WebGLRenderer created, capabilities: {...}`
   - `[R29] Scene populated, ready to render`
   - `[R29] First Three.js frame submitted` (in loop(), fires once on first frame)

5. **Three.js r170 vendored locally**: `vendor/three/r170/three.module.js` + 6 addon files downloaded from unpkg and pinned. Importmap in `shell.html` updated from `unpkg.com` URLs to `./vendor/three/r170/...`. CDN is eliminated — game works offline. MIT LICENSE included.

6. **Version bump**: footer changed `0.3` → `0.4 / R29 hotfix` so the deploy is verifiable.

---

## Expected console after this fix

```
[R17] Three.js renderer (default). Use ?renderer=legacy to fall back.
[R29] _setRenderMode is exported, switching to mode 1 (Three.js)
[R29] renderer.js module loaded, calling start()
[R29] renderer.js start() entered
[R29] WebGLRenderer created, capabilities: {...}
[R29] Scene populated, ready to render
=== Starsiege: Tribes — Browser Edition ===
... (existing init logs)
[R29] First Three.js frame submitted
```

**Forbidden**: any `[SHADER] Link error`, `[SHADER] Compile error`, `useProgram: program not valid`, `[R29] renderer.js import FAILED`, `[R29] _setRenderMode is NOT exported`.

---

## Files changed

- `program/code/wasm_main.cpp` — all 8 legacy shaders: `precision highp float; precision highp int;` added/upgraded.
- `shell.html` — removed Three.js init from `startGame()`, added to `onRuntimeInitialized` with `[R29]` logs. Updated importmap to `./vendor/three/r170/...`. Version footer bumped.
- `renderer.js` — `[R29]` diagnostic logs in `start()` and `loop()`.
- `build.sh` — moved comment outside the multi-line emcc command.
- `vendor/three/r170/three.module.js` (NEW, 1.3 MB) — pinned Three.js r170.
- `vendor/three/r170/addons/{objects/Sky.js,postprocessing/EffectComposer.js,RenderPass.js,UnrealBloomPass.js,ShaderPass.js,OutputPass.js}` (NEW, 6 files).
- `vendor/three/r170/LICENSE` (NEW) — MIT.
- `vendor/three/README.md` (NEW) — update procedure.

---

## Runtime criteria (user must verify in Chrome)

1. Zero shader link/compile errors in console on fresh load.
2. Zero `useProgram: program not valid` warnings during 30s play.
3. 3D terrain + sky visible on first frame after PLAY.
4. Five `[R29]` log lines appear in order.
5. `?renderer=legacy` also works (precision fix applies to both paths).
6. DevTools Network shows `vendor/three/r170/three.module.js` HTTP 200, not unpkg.com.

---

## R30 context

Per Manus R29 brief: R30 will delete the legacy WebGL renderer entirely (~1500 lines C++/GLSL removed, Three.js becomes the only rendering path).
