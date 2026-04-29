# Item 18 — Extract renderer_postprocess.js

## Change Summary
Extracted post-processing pipeline from renderer.js (~185 lines) into standalone `renderer_postprocess.js` ES module.

**Commit:** `refactor(R32.232): extract renderer_postprocess.js from renderer.js`

## Functions Extracted
- `initPostProcessing()` → `PostProcess.init(renderer, scene, camera, tier, quality)`
- `_buildCinematicLUT()` → `_buildCinematicLUT()` (internal)
- `makeVignetteAndGradeShader()` → `_makeVignetteAndGradeShader()` (internal)
- Bloom update logic → `PostProcess.update(dayMix)`
- Grade pass time tick → included in `PostProcess.update()`
- Render call → `PostProcess.render()`
- Resize handling → `PostProcess.resize(w, h)`

## Module API
```javascript
export function init(renderer, scene, camera, tier, currentQuality)
export function update(dayMix)      // night-adaptive bloom + film grain
export function render()             // composer.render() or fallback
export function resize(w, h)         // handles composer + gradePass resolution
export function dispose()            // MANDATORY — GPU leak prevention
export function rebuild(tier, quality) // dispose + re-init for quality changes
export function getComposer()        // read-only accessor
export function getBloomPass()       // read-only accessor
export function getGradePass()       // read-only accessor
export function isActive()           // true if composer exists
```

## Wiring in renderer.js
- Import: `import * as PostProcess from './renderer_postprocess.js?v=203'`
- Removed: `let composer`, `let bloomPass, gradePass`
- init call: `PostProcess.init(renderer, scene, camera, readQualityFromSettings(), currentQuality)`
- Quality change: `PostProcess.rebuild(readQualityFromSettings(), currentQuality)`
- Render loop: `PostProcess.update(dm)` + `PostProcess.render()`
- Resize: `PostProcess.resize(w, h)`
- Debug: `get composer() { return PostProcess.getComposer(); }`
- Toggle: `PostProcess.isActive()` / `PostProcess.dispose()`

## Cohort Review

### Pass 1 — Structural Integrity (Carmack)
**PASS.** Clean extraction. All post-processing state is now encapsulated. Module-level variables `_composer`, `_bloomPass`, `_gradePass` are private. The renderer.js no longer has any post-processing logic except delegating to the module.

### Pass 4 — Integration Risk (Fiedler)
**PASS.** All 6 call sites in renderer.js updated:
1. Initial setup (L279)
2. Polish install (L283 — passes composer reference)
3. Debug panel (L370 — getter for live reference)
4. Quality change (L4258)
5. Render loop bloom/grade (L5040-5084 → single update() call)
6. Resize (L5143-5155 → single resize() call)
7. Final render (L5100 → PostProcess.render())

### Pass 5 — Dispose/Lifecycle (Acton)
**PASS.** The dispose() function is present and properly cleans up:
- Calls composer.dispose() with fallback for older Three.js
- Nulls out all references
- Clears window debug globals
- Safe to call multiple times (idempotent)

## Risk Assessment
**MEDIUM.** Large extraction but mechanically faithful. All logic preserved verbatim. Main risk is the shared working directory causing version conflicts with parallel agents.
