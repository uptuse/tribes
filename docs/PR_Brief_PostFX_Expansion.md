# PR Brief: Post FX Expansion & Panel Fix

**Date:** April 29, 2026
**Target:** `renderer.js`, `post_fx.js`, `index.html`
**Objective:** Rebuild the EffectComposer pipeline to fix the `da1419b` black-screen regression, and expand the Shift+Enter panel with SSAO, SMAA, Sobel Outlines, LUT Color Grading, and a faked Motion Blur.

This brief outlines the exact integration points and code structure required to ship these five visual upgrades safely.

## 1. Architectural Fix: The Composer Pipeline

The previous `post_fx.js` implementation caused a black screen because it tried to splice passes into an already-running `EffectComposer`.

**The Fix:** `renderer.js` must construct the *entire* pass chain inside `initPostProcessing()`. Do not export a function that mutates the composer later.

```javascript
// renderer.js - inside initPostProcessing()
composer = new EffectComposer(renderer);
composer.setPixelRatio(tier.pixelRatio);

const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

// Add SSAO immediately after RenderPass
const ssaoPass = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight);
ssaoPass.kernelRadius = 16;
ssaoPass.enabled = false; // Toggled by UI
composer.addPass(ssaoPass);

// Add existing Bloom
bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.30, 0.45, 0.92);
composer.addPass(bloomPass);

// Add Sobel (Edge Detect)
const sobelPass = new ShaderPass(SobelOperatorShader);
sobelPass.uniforms['resolution'].value.x = window.innerWidth * window.devicePixelRatio;
sobelPass.uniforms['resolution'].value.y = window.innerHeight * window.devicePixelRatio;
sobelPass.enabled = false;
composer.addPass(sobelPass);

// Add custom VFXShader (Chroma, Grain, GodRays, DOF) here
// ...

// Add SMAA before the final OutputPass
const smaaPass = new SMAAPass(window.innerWidth * renderer.getPixelRatio(), window.innerHeight * renderer.getPixelRatio());
smaaPass.enabled = false;
composer.addPass(smaaPass);

// Add OutputPass
composer.addPass(new OutputPass());

// Expose pass references to window.__postFX so index.html sliders can toggle them
window.__postFX = {
    ssaoPass,
    smaaPass,
    sobelPass,
    // ...
};
```

## 2. SSAO (Screen Space Ambient Occlusion)

**Imports Required:**
`import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';`

**UI Wiring (`index.html`):**
Add a toggle and radius slider.
```html
<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
  <label style="width:90px;color:#9A8A6A;font-size:0.8em;">
    <input type="checkbox" id="pfx-ssao-on" onchange="pfxSSAO()"> SSAO
  </label>
  <input type="range" style="flex:1;" id="pfx-ssao" min="1" max="32" value="16" oninput="pfxSSAO()">
</div>
```
```javascript
function pfxSSAO() {
  if (!window.__postFX || !window.__postFX.ssaoPass) return;
  window.__postFX.ssaoPass.enabled = document.getElementById('pfx-ssao-on').checked;
  window.__postFX.ssaoPass.kernelRadius = parseFloat(document.getElementById('pfx-ssao').value);
}
```

## 3. SMAA (Anti-Aliasing)

**Imports Required:**
`import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';`

**UI Wiring (`index.html`):**
```html
<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
  <label style="width:90px;color:#9A8A6A;font-size:0.8em;">
    <input type="checkbox" id="pfx-smaa-on" onchange="pfxSMAA()"> SMAA (Anti-Aliasing)
  </label>
</div>
```
```javascript
function pfxSMAA() {
  if (window.__postFX && window.__postFX.smaaPass) {
    window.__postFX.smaaPass.enabled = document.getElementById('pfx-smaa-on').checked;
  }
}
```

## 4. Sobel Edge Detect (Comic/Retro Style)

**Imports Required:**
`import { SobelOperatorShader } from 'three/addons/shaders/SobelOperatorShader.js';`

**UI Wiring (`index.html`):**
```html
<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
  <label style="width:90px;color:#9A8A6A;font-size:0.8em;">
    <input type="checkbox" id="pfx-sobel-on" onchange="pfxSobel()"> Edge Detect
  </label>
</div>
```
```javascript
function pfxSobel() {
  if (window.__postFX && window.__postFX.sobelPass) {
    window.__postFX.sobelPass.enabled = document.getElementById('pfx-sobel-on').checked;
  }
}
```

## 5. LUT Color Grading (Mood Presets)

Firewolf already has a procedural LUT generator (`_buildCinematicLUT` in `renderer.js`). We need to expose a dropdown that swaps the LUT texture in the existing `gradePass`.

**Implementation:**
Modify `_buildCinematicLUT` to accept a "mood" parameter, or generate 3 different textures at startup (e.g., `lutCinematic`, `lutMatrixGreen`, `lutMarsRed`).

**UI Wiring (`index.html`):**
```html
<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
  <label style="width:90px;color:#9A8A6A;font-size:0.8em;">Color Grade</label>
  <select id="pfx-lut" style="flex:1;background:#1a1510;color:#E0D0A0;border:1px solid #3A3020;" onchange="pfxLUT()">
    <option value="cinematic">Cinematic (Warm)</option>
    <option value="matrix">Matrix (Green)</option>
    <option value="mars">Mars (Red)</option>
    <option value="none">Off</option>
  </select>
</div>
```
```javascript
function pfxLUT() {
  if (window.__postFX && window.__postFX.setLUT) {
    window.__postFX.setLUT(document.getElementById('pfx-lut').value);
  }
}
```

## 6. Fake Motion Blur (Camera Velocity Accumulation)

True per-pixel motion blur requires a velocity buffer from the C++ engine, which is too expensive/complex for this sprint. Instead, we can fake the "speed" feeling using a radial blur triggered by camera rotation (snap turns) or forward velocity.

**Implementation Strategy (Camera-Only):**
1. Add a custom `RadialBlurShader` pass (or use `FocusShader` if available).
2. In `renderer.js` during the render loop, calculate the delta of the camera's yaw/pitch since the last frame.
3. If the delta exceeds a threshold (e.g., a fast mouse flick), set the `RadialBlur` strength proportional to the delta.
4. Decay the strength rapidly back to zero using `Math.lerp`.

This gives the visceral "whoosh" feeling during fast 180° turns without the massive overhead of tracking individual object velocities.
