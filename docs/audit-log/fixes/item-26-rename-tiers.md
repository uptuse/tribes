# Item 26 — Rename client/tiers.js → client/skill_rating.js

**Commit:** R32.174 (4ac968e) — bundled with Three.js pinning by concurrent agent
**Cleanup commit:** R32.175+ (stale console.log strings updated in index.html/shell.html)
**Date:** 2026-04-29
**Panel:** Muratori, Barrett (scaled review — small rename, Pass 1 + Pass 4)

---

## Pass 1 — Break It

**Saboteur:** Can this rename break anything?

1. **Import paths updated?** Yes — both `index.html` (line 4319) and `shell.html` (line 3506) now import `./client/skill_rating.js`. ✅
2. **Console.log strings updated?** Yes — changed from `'tiers.js loaded'` to `'skill_rating.js loaded'` in both files. ✅
3. **Comment references updated?** Yes — `renderer.js` comment (line 2792) and both HTML files' deferred-tier comments now reference `skill_rating.js`. ✅
4. **Does `window.__tiers` need renaming?** No — the global `window.__tiers` is a runtime API name, not a file path. It's consumed by multiple HUD systems via `window.__tiers.tierForRating()`. Renaming the global is a separate, higher-risk change. ✅ (left as-is intentionally)
5. **Server-side import?** The original header says "server re-exports via server/tiers.ts." Checked: no `server/` directory in this repo. Server is a separate codebase. The server maintainer needs to update their import path. ⚠️ (out of scope, noted)
6. **Git history preserved?** `git mv` used → `git log --follow client/skill_rating.js` traces back. ✅

**Verdict: No bugs introduced.** The naming collision with quality tiers is eliminated.

---

## Pass 4 — System-Level Review

**Barrett:** The rename is correct and important. `client/tiers.js` sat next to renderer code that uses "quality tiers" extensively. A developer searching for "tiers" to debug quality-tier fallback would hit this file first and waste time. `client/skill_rating.js` is unambiguous — it's about player skill ratings, period.

**Muratori:** The `window.__tiers` global is still named `__tiers`. That's a minor inconsistency — the file is `skill_rating.js` but exports to `window.__tiers`. Not worth changing now (too many consumers), but note it for the future IIFE→ES migration where the global goes away entirely.

**Barrett:** One follow-up: the server's `server/tiers.ts` still references the old filename. Since the server is a separate repo, this should be flagged as a required coordination item. Not blocking, but will 404 if the server tries to import the old path.

**Verdict: Clean. One out-of-scope follow-up (server import path).**

---

## Summary

| Check | Status |
|---|---|
| Import paths updated | ✅ |
| Console strings updated | ✅ |
| Comment refs updated | ✅ |
| No broken references | ✅ |
| Git history preserved | ✅ |
| Version chip bumped | ✅ |
| Server path noted | ⚠️ Out of scope |
