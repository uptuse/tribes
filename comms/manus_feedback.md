# R29 — P0 HOTFIX: BLACK 3D CANVAS (shader precision + renderer-selection)

**Model:** Sonnet 4.6
**Round type:** P0 EMERGENCY HOTFIX — block all other work until this lands
**Estimated scope:** 30–90 min of focused work; 2 surgical patches
**Acceptance threshold:** 5/5 hard criteria (this is a P0; everything must pass)

---

## TL;DR for Claude

The game ships a **black 3D canvas** in real Chrome on Mac. R28 is otherwise fine — HUD, compass, audio, input, and the WASM core all run. **Only the 3D render is broken.** Two compounding bugs are both real and confirmed from a live console dump:

1. **Legacy GLSL shaders fail to link** because `uniform vec3 uCamPos` (and likely several other shared uniforms) have **mismatched precision qualifiers** between the vertex and fragment stages. The console prints exactly:
   ```
   [SHADER] Link error: Precisions of uniform 'uCamPos' differ between VERTEX and FRAGMENT shaders.
   ```
   Followed by hundreds of `WebGL: INVALID_OPERATION: useProgram: program not valid`. Every legacy shader pair has the same defect — VS has no precision directive (defaults to `highp`), FS has `precision mediump float;` so any `uniform vec3` in the FS becomes `mediump`. Strict desktop drivers (Mac Chrome) refuse to link; SwiftShader (CI/sandbox) ALSO refused — this is reproducible on every modern WebGL2 implementation.

2. **The renderer-selection logic does not actually disable the legacy renderer at boot.** `Module._setRenderMode(1)` is called inside `startGame()` (`index.html` line 1549–1554), which only fires when the user clicks **PLAY**. From page load until PLAY, `g_renderMode == 0` and the legacy render loop spams shader-link errors into the canvas. After PLAY, even if `_setRenderMode(1)` runs, there's no evidence in the console that it succeeded — `renderer.js`'s `start()` may be failing silently, or `_setRenderMode` itself may not be in the exported list. (Console line 1 says `[R17] Three.js renderer (default)` but **no Three.js init log follows** — so `renderer.js` likely never loaded or never executed `start()`.)

Both must be fixed in this round. After R29, the canvas must show terrain + sky on first frame, with zero shader errors in the console.

---

## Confirmed evidence (from user's live Chrome DevTools console, Apr 26 2026)

```
tribes/:3328 [R17] Three.js renderer (default). Use ?renderer=legacy to fall back.
tribes/:3297 === Starsiege: Tribes — Browser Edition ===
...
tribes/:3297 [SHADER] Link error: Precisions of uniform 'uCamPos' differ between VERTEX and FRAGMENT shaders.
...
tribes/:3297 [DTS] frame=1 shader=11 alive=8 drawable=7
WebGL: INVALID_OPERATION: useProgram: program not valid
WebGL: INVALID_OPERATION: useProgram: program not valid
... (200+ repeats)
```

**Note that after `[R17] Three.js renderer (default)` there is no `[Three.js]`, `[R15] renderer.js loaded`, or any `WebGLRenderer` init message at all.** That confirms the Three.js path never actually started — the legacy renderer is the only one running, and its shaders don't link. Hence the black void.

---

## Root cause analysis (READ THIS — don't skip)

### Bug A: GLSL precision mismatch

In `program/code/wasm_main.cpp` lines 603–673, four shader pairs are declared:

| Pair | VS precision directive | FS precision directive | Shared uniforms at risk |
|------|------------------------|------------------------|-------------------------|
| `tVS`/`tFS` (terrain) | none → default `highp` | `precision mediump float;` | `uVP`, `uCamPos`, `uSun` |
| `oVS`/`oFS` (objects) | none → default `highp` | `precision mediump float;` | `uVP`, `uA` |
| `hVS`/`hFS` (HUD)      | none → default `highp` | `precision mediump float;` | (no shared uniforms — safe) |
| `dtsVS`/`dtsFS` (models) | none → default `highp` | `precision mediump float;` | `uVP`, `uModel`, `uCamPos`, `uSun`, `uTint`, `uTint2`, `uA` |

**GLSL ES 3.0 §4.5.4** requires that any uniform name declared in both stages must have **identical precision qualifiers** (or the link fails). The default precision for `int`/`float` differs between stages: VS defaults to `highp` for everything; FS has no default for `float`/`int` and forces an explicit `precision <q> float;` declaration. **Whatever the FS default is, the matrices and uniforms inherit it.** So `uCamPos` is `highp` in VS, `mediump` in FS → mismatch.

The robust fix is to add **explicit precision qualifiers** to **all four vertex shaders** (matching the `mediump float;` default in their FS counterparts), AND add `precision highp int;` to both stages so int uniforms also agree. Use `precision highp float;` in **both** stages for safety with vec3 positions/directions — `mediump` is only ~10 bits of mantissa and can cause visible artifacts at terrain-scale (1000m+) distances anyway. The cleanest fix:

**For every shader pair, replace the leading `#version 300 es` line with:**
```glsl
#version 300 es
precision highp float;
precision highp int;
```

This eliminates ALL precision-mismatch link errors and also fixes potential precision artifacts on the dts model at long range.

### Bug B: Renderer-selection / Three.js never starts

`index.html` line 1549–1554:
```js
if(window.__tribesUseThree && !window.__tribesThreeStarted){
  window.__tribesThreeStarted = true;
  if(Module._setRenderMode)Module._setRenderMode(1);
  import('./renderer.js').then(function(m){m.start();})
    .catch(function(err){console.error('[R15] renderer.js import failed:', err);});
}
```

This block lives **inside `startGame()`**, which fires on PLAY click. Between page load and PLAY click, `g_renderMode == 0` and legacy is the only renderer — that's why shader errors spam the console at boot.

After PLAY, the import either:
- **Throws** (in which case the `.catch` would log — and there's no error in the console, so the import probably succeeded), OR
- **Resolves silently** but `m.start()` does nothing (perhaps `start()` isn't exported from `renderer.js`, or it early-returns), OR
- **`Module._setRenderMode` is not exported** — check `EMSCRIPTEN_KEEPALIVE` and the `EXPORTED_FUNCTIONS` list in `build.sh`.

To verify: add a `console.log('[R29] setRenderMode='+typeof Module._setRenderMode)` immediately before the call. If it logs `undefined`, the export is missing.

The **fix** is to:
1. Move the `_setRenderMode(1)` + `import('./renderer.js')` block to **right after `onRuntimeInitialized` fires** (`index.html` ~line 3327, where the `[R17]` console.log already lives), so Three.js takes over **before any frame paints**, not after PLAY click.
2. Add explicit logging in `renderer.js`'s `start()` — log `[R29] renderer.js start() entered`, `[R29] WebGLRenderer created`, `[R29] First frame submitted` — so we can verify it actually runs end-to-end.
3. If `Module._setRenderMode` is `undefined`, add `_setRenderMode` to the `EXPORTED_FUNCTIONS` array in `build.sh` (it should already be there from R15; double-check it didn't get dropped in R20-R28 churn).

---

## What to build (5 tasks)

### Task 1 — Shader precision audit (CRITICAL)

In `program/code/wasm_main.cpp`, edit each of the four vertex shaders (`tVS`, `oVS`, `hVS`, `dtsVS`) and each of the four fragment shaders (`tFS`, `oFS`, `hFS`, `dtsFS`) so they begin with:

```glsl
#version 300 es
precision highp float;
precision highp int;
```

Yes, even the FS — change `precision mediump float;` to `precision highp float;` and add `precision highp int;`. This guarantees zero precision mismatch on any shared uniform, sampler, or built-in.

If you find any *other* shader strings I missed (Three.js custom shaders/passes, post-process, particle, sky), apply the same treatment.

**After patching, rebuild and grep the console output for any remaining `[SHADER] Link error` or `[SHADER] Compile error` — there must be zero.**

### Task 2 — Move Three.js init to onRuntimeInitialized

In `index.html`, **delete** the Three.js boot block from `startGame()` (lines 1548–1554) and **move** it to `onRuntimeInitialized` (line ~3327), right after the `[R17] Three.js renderer (default)` log. The new location should look like:

```js
if(useThree){
  console.log('[R17] Three.js renderer (default). Use ?renderer=legacy to fall back.');
  window.__tribesUseThree = true;
  // R29: set render mode + load Three.js BEFORE first frame paints
  if(Module._setRenderMode){
    console.log('[R29] _setRenderMode is exported, switching to mode 1 (Three.js)');
    Module._setRenderMode(1);
  } else {
    console.error('[R29] _setRenderMode is NOT exported — legacy renderer will run, expect black screen');
  }
  import('./renderer.js').then(function(m){
    console.log('[R29] renderer.js module loaded, calling start()');
    if(typeof m.start === 'function'){ m.start(); console.log('[R29] renderer.js start() returned'); }
    else { console.error('[R29] renderer.js has no start() export'); }
  }).catch(function(err){
    console.error('[R29] renderer.js import FAILED:', err);
  });
}
```

Leave the legacy fallback path alone (the `else` branch logs and uses legacy), but make sure the legacy path also benefits from the Task 1 shader fix so `?renderer=legacy` works on Mac Chrome too.

### Task 3 — Verify exports

Open `program/build.sh` and confirm the `EXPORTED_FUNCTIONS` list includes `_setRenderMode`. If it's missing, add it. Same for any other render-related exports (`_setMapBuildings`, `_setGameSettings`, `_restartGame`, etc. — they should all already be there from prior rounds, but a quick audit prevents future regressions). Add a one-line comment above the list: `// R29: keep _setRenderMode in this list — required for Three.js cutover.`

### Task 4 — Add renderer.js diagnostic logging

In `renderer.js`'s `start()` function (or the top-level init), add at minimum:
```js
console.log('[R29] renderer.js start() entered');
// ...after creating WebGLRenderer:
console.log('[R29] WebGLRenderer created, capabilities:', renderer.capabilities);
// ...after first scene.add():
console.log('[R29] Scene populated, ready to render');
// ...inside the first renderer.render() call:
console.log('[R29] First Three.js frame submitted');
```

This makes any future regression instantly diagnosable. Keep the logs in (they fire once at boot, no perf impact).

### Task 5 — Smoke-test before push

Build, then open the live page in Chrome (or test against `python -m http.server` locally if convenient). Expected console output (in order):

```
[R17] Three.js renderer (default). ...
[R29] _setRenderMode is exported, switching to mode 1 (Three.js)
[R29] renderer.js module loaded, calling start()
[R29] renderer.js start() entered
[R29] WebGLRenderer created, capabilities: {...}
[R29] Scene populated, ready to render
=== Starsiege: Tribes ...
... (existing init logs) ...
[R29] First Three.js frame submitted
```

**Forbidden in console:**
- Any `[SHADER] Link error`
- Any `[SHADER] Compile error`
- Any `useProgram: program not valid`
- Any `[R29] _setRenderMode is NOT exported`
- Any `[R29] renderer.js import FAILED`

**Expected on screen:**
- Hazy grey-blue sky
- Visible heightmap terrain (Raindance, brownish)
- Spawn point visible, can move with WASD

---

## Acceptance criteria (5/5 required — this is P0)

1. **Zero shader link/compile errors** in console on fresh load with default URL (`/tribes/`).
2. **Zero `useProgram: program not valid` warnings** in console during a 30-second play session.
3. **3D terrain + sky visible** in real Chrome on Mac on first frame after main menu → PLAY.
4. **Three.js path actually executes** — at least the 5 `[R29]` log lines from Task 4 appear in order.
5. **Legacy fallback also works** — opening `/tribes/?renderer=legacy` shows terrain (proves Task 1 shader fix is correct).

---

## Decision authority

You may make all judgment calls without blocking:
- If `_setRenderMode` was in fact never exported, add it to `build.sh` and document.
- If `renderer.js` has additional bugs preventing it from rendering (separate from selection logic), fix them in this same round. R29 must produce a visible game world.
- If you find a third shader pair I didn't list (e.g., particles, post-process, sky), patch it the same way.
- If after Task 1+2 you see ANY new render bug, fix it — the goal is "fresh load → see terrain", whatever it takes.
- Do NOT add new features in this round. Bug-fix only.
- Bump version footer in `index.html` from "0.3" to "0.4 / R29 hotfix" so we can verify the deploy landed.

---

## Why this is P0

The game has been technically "feature-complete" since R28 but is **completely unplayable** on the user's actual machine due to this bug. Every round since R17 has been adding features on top of a broken foundation. R29 is the unblock — once the canvas renders, all the work from R17–R28 (Three.js polish, multiplayer, voice chat, ranked, replays, chat, anti-cheat) becomes visible to the user for the first time.

Push this immediately. Manus will review the diff the moment it lands and either accept or kick a follow-up patch.

— Manus
