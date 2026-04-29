# Item 25 — Rename renderer_sky_custom.js → renderer_sky.js

**Commit:** R32.169 (dbeea4d)
**Date:** 2026-04-29
**Panel:** Muratori, ryg (scaled review — small rename, Pass 1 + Pass 4)

---

## Pass 1 — Break It

**Saboteur:** Can this rename break anything?

1. **Import path updated?** Yes — `renderer.js` line 36 changed from `./renderer_sky_custom.js` to `./renderer_sky.js?v=169`. Cache bust added. ✅
2. **Comments updated?** Yes — lines 23 and 133 in `renderer.js`, line 1 in `renderer_sky.js` itself. ✅
3. **Any other importers?** Grep confirms only `renderer.js` imports this file. No `index.html` or `shell.html` references. ✅
4. **Git history preserved?** `git mv` used, so `git log --follow renderer_sky.js` traces back to original. ✅
5. **Can the old filename still be requested by browser cache?** Yes — any browser that cached the old import will 404 on `renderer_sky_custom.js`. But the `?v=169` cache bust on the import line forces a fresh fetch of `renderer_sky.js`. The only risk: if `renderer.js` itself is cached without the `?v=169` bust. Check: the index.html import of renderer.js uses `__cacheVer` from the version chip, which was bumped to R32.169. ✅ Cache chain is sound.

**Verdict: No bugs introduced.** This is a clean rename.

---

## Pass 4 — System-Level Review

**Muratori:** The rename is correct. "renderer_sky_custom" was always misleading — there's no "renderer_sky_default" to distinguish from. The `_custom` suffix was an artifact of when THREE.Sky was the primary sky implementation and this was the "custom" replacement. THREE.Sky was removed at R32.63. The suffix should have been dropped then. Better late than never.

**ryg:** One minor observation: the file still internally exports functions named `initCustomSky`, `updateCustomSky`, `removeOldSky`. The "Custom" prefix on these function names is the same artifact. Not urgent — function names are internal — but if we're cleaning up naming, a future pass could rename to `initSky`, `updateSky`, `removeSky`.

**Muratori:** Agree, but don't mix that into this commit. Renaming exports changes the import lines in every consumer. That's a separate change. This commit correctly limits scope to the file rename only.

**Verdict: Clean. No further action needed.**

---

## Summary

| Check | Status |
|---|---|
| Import path updated | ✅ |
| Cache bust added | ✅ |
| Comments updated | ✅ |
| No broken references | ✅ |
| Git history preserved | ✅ |
| Version chip bumped | ✅ |
| No scope creep | ✅ |
