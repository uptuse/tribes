# Item 9 Review — Dispose EffectComposer (R32.161)

**Change:** 18 lines added at top of `initPostProcessing()`.
**Panel:** Carmack, ryg (small perf change — Pass 1 + Pass 4)

---

## Pass 1 — Break It

**Saboteur:**
- **S1 (Low):** After disposing the old composer, `bloomPass` and `gradePass` are set to null. Any code that reads `bloomPass.enabled` or `bloomPass.strength` between dispose and re-creation would NPE. **Check:** `applyQuality()` calls `initPostProcessing()` synchronously, then `onResize()`. No frame renders between dispose and re-creation. The render loop reads `composer` → null guard already exists at render time. **Safe.**
- **S2 (None):** `window.__tribesBloom` and `window.__tribesComposer` are reassigned at the end of `initPostProcessing()` after re-creation. During the brief synchronous gap they point at disposed objects. No async code reads them during this window.
- **S3 (None):** EffectComposer.dispose() is available in Three.js r167 (the version in use). The fallback for older versions is included but won't execute.

## Pass 4 — System-Level

**Leak magnitude:** At 1920×1080 with pixelRatio=1: each WebGLRenderTarget = 1920×1080×4 bytes × 2 (color + depth) ≈ 16MB. EffectComposer creates 2 targets = ~32MB. Plus bloom pass creates additional targets. Total per-composer: ~40MB. Each quality switch leaked this amount.

**After fix:** Old targets are freed before new ones are allocated. Peak memory during switch is 2× (old still allocated while new being created) → 1× (old disposed first, then new created). Better.

---

## Verdict: ✅ PASS — Clean disposal. Significant memory savings.
